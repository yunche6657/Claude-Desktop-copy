// Local command execution.
//
// This is the capability the Code view has and a chat UI does not: running a
// command on the user's machine. It is deliberately narrow:
//
//   * only an explicit allowlist of executables can run at all;
//   * shell metacharacters are refused, so a command is argv, not a shell line;
//   * the working directory must exist and stay inside an approved root;
//   * output is bounded, and the child is killed on timeout.
//
// Every invocation is meant to pass through the consent manager first; this
// module never decides on its own whether something may run.
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

// Commands this reconstruction is willing to run. Anything else is refused
//
// `find` is deliberately NOT in this list, even on platforms where a binary answers to the
// name. Measured: C:\Windows\System32\find.exe exists and resolves, so availability said
// yes — but it is the Windows TEXT search tool, not Unix find. A model writing the natural
// `find test -name *.test.mjs` got exit 2 and no output, then retried the same command.
// A wrong-but-present binary is worse than a missing one: the refusal machinery never fires.
// before a consent prompt is even shown, so the user is never asked to approve
// something that would then be rejected anyway.
const ALLOWED_EXECUTABLES = new Set([
  'git', 'node', 'npm', 'npx', 'pnpm', 'yarn',
  'python', 'python3', 'pip',
  'ls', 'dir', 'cat', 'type', 'pwd', 'echo', 'head', 'tail', 'wc',
  'grep', 'rg', 'where', 'which',
  'tsc', 'eslint', 'vitest', 'jest', 'cargo', 'go', 'rustc',
]);

// Only characters a shell INTERPRETS belong here.
//
// Backslash, quotes, braces, parentheses and $ are deliberately absent: the child is
// spawned with `shell: false` (see runCommand), so those bytes reach the program verbatim
// and cannot start a second command.
//
// Measured before this was narrowed: the model asked to run node -e "console.log(6*7)"
// and was refused because of the parentheses. It then proposed writing a script file
// instead - a working but wasteful detour the allowlist was never meant to force.
// Ordinary node -e, python -c and grep with a brace pattern all failed the same way.
const SHELL_METACHARACTERS = /[;&|<>`$\n\r]/;

/** Split a command line into argv, removing paired quotes. Not a shell parser. */
function stripQuotes(input) {
  const out = [];
  let current = "";
  let quote = null;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) { quote = null; } else { current += ch; }
      continue;
    }
    if (ch === "\"" || ch === "'") { quote = ch; continue; }
    if (/\s/.test(ch)) { if (current) { out.push(current); current = ""; } continue; }
    current += ch;
  }
  // "unbalanced quote" alone leaves the caller guessing which end was wrong, and its only
  // other option is to try the same line again. Name the fix: close the quote or drop it.
  if (quote) throw new Error('unbalanced quote in command: a quote was opened and never closed;'
    + ' close it (add the same quote character at the end of that argument) or remove both'
    + ' quotes — for a multi-word argument, keep one pair around the whole value');
  if (current) out.push(current);
  return out;
}

/** True when a shell operator appears outside quotes in the raw command line. */
function hasOperatorOutsideQuotes(input) {
  let quote = null;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (SHELL_METACHARACTERS.test(ch)) return true;
  }
  return false;
}

function parseCommand(raw) {
  // Name the argument and its expected shape: a caller that already sent the key cannot tell
  // from "must be a string" whether it sent an array, an args list, or nothing at all.
  if (typeof raw !== 'string') {
    throw new Error('command must be a string: pass "command" as one command-line string'
      + ' (not an argv array), e.g. {command: "git status --short"}');
  }
  const trimmed = raw.trim();
  // An empty command is usually a lost argument, not an empty intention.
  if (!trimmed) throw new Error('command is empty: pass "command" as a non-empty string,'
    + ' e.g. {command: "git status --short"}');
  // The number matters: it says how far over the caller is and whether shortening is enough.
  if (trimmed.length > 4096) throw new Error('command is too long: ' + trimmed.length
    + ' characters, the limit is 4096; shorten it, and put anything longer in a file'
    + ' (Write a script, then run it with an allowlisted program such as node)');
  // Reject a shell operator only when it appears OUTSIDE quotes.
  //
  // A ; inside a quoted argument is data, not a separator: node -e "const a=1; console.log(a)"
  // is an ordinary inline program, and the child receives the semicolon as source text.
  // Scanning the raw string with quote state is what distinguishes the two; stripping the
  // quotes first and then scanning would treat the data as if it were code.
  if (hasOperatorOutsideQuotes(trimmed)) {
    throw new Error('command contains shell operators (; & | < > ` or a newline); this executor'
    + ' runs one program with no shell, so send a single command instead: drop the pipe or'
    + ' redirection and run the one program you need (for file work use Read / List / Glob,'
    + ' which never need approval)');
  }
  // argv honours paired quotes (stripQuotes): removing them is the whole job, so an argument
  // may contain spaces. There is still no shell: no variable expansion, no globbing, and the
  // child runs with shell: false.
  const [executable, ...args] = stripQuotes(trimmed);
  const base = path.basename(executable).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
  if (!ALLOWED_EXECUTABLES.has(base)) {
    // Name the names that ARE accepted, not just the refusal: without a replacement the
    // caller's only move is to guess another name, and each guess is a wasted round trip.
    //
    // "accepts", NOT "starts": ls, cat, npm and friends are allowlisted and still have no
    // spawnable binary on Windows. Promising that they start would send the caller straight
    // into the availability refusal — a second failure with a different message.
    throw new Error('executable "' + base + '" is not in the allowlist; the accepted names are: '
      + [...ALLOWED_EXECUTABLES].join(', ')
      + '. Rewrite the command with one of them (node and git are the safest — some accepted'
      + ' names are absent on a given machine), or use Read / List / Glob for file work');
  }
  return { executable, args, display: trimmed };
}

// Which of the allowlisted names this machine can actually start.
//
// The allowlist above is a list of NAMES, and a name is not a program. Measured on this host
// (tools/_exec-availability.cjs): 23 of the 30 allowlisted names cannot be spawned at all --
// ls, cat, echo, pwd, dir, type are PowerShell ALIASES with no .exe behind them, and npm,
// npx, pnpm, yarn, tsc, eslint are .cmd shims that a shell:false spawn cannot start (Node
// needs cmd.exe for those and refuses with EINVAL).
//
// The consequence used to surface in the worst possible place: the user was asked to approve
// "echo hello", clicked Allow, and then exec failed with ENOENT. A person reads that as "the
// approval system is broken". It is not -- the binary was never there.
//
// So availability is resolved BEFORE consent: a command that cannot run is refused with a
// message naming the reason, and no approval prompt is ever shown for it.

// Resolution is cached per name.
//
// `defaultResolve` shells out to `where.exe`, which costs ~100 ms per call. Without a cache
// every Bash tool call paid that again — and the allowlist test that checks all 30 names took
// 3.7 s of pure subprocess time. The answer cannot change while the process runs: PATH is
// fixed at startup, and installing a tool mid-session is not something this build supports.
//
// The cache is keyed by the name only when the default resolver is used; an injected
// resolver (tests pass one) bypasses it so stubs keep working.
const spawnableCache = new Map();

/** True when the path is an existing file, or a bare name that resolves on PATH. */
function isSpawnable(executable, resolve, customResolver = false) {
  // Only the real resolver is cached: a caller-supplied stub must be consulted every time.
  const useCache = !customResolver;
  if (useCache && spawnableCache.has(executable)) return spawnableCache.get(executable);
  let verdict = { spawnable: false, resolved: null };
  try {
    const resolved = (resolve || defaultResolve)(executable);
    if (resolved) verdict = { spawnable: true, resolved };
  } catch { /* fall through to the negative answer */ }
  if (useCache) spawnableCache.set(executable, verdict);
  return verdict;
}

// Windows: a bare name only works if PATH holds a .exe; .cmd/.bat need a shell.
function defaultResolve(executable) {
  // where.exe answers for .exe, .cmd and .bat, so ask it and then check the extension:
  // finding "npm.cmd" is not the same as being able to spawn "npm".
  const { spawnSync } = require('node:child_process');
  const probe = spawnSync('where.exe', [executable], {
    shell: false, windowsHide: true, timeout: 5000, encoding: 'utf8',
  });
  if (probe.error || probe.status !== 0) return null;
  const first = String(probe.stdout || '').split(/\r?\n/).map(function (line) { return line.trim(); }).filter(Boolean)[0];
  if (!first) return null;
  if (/\.(cmd|bat)$/i.test(first)) return null;
  return /\.(exe|com)$/i.test(first) ? first : null;
}

/**
 * Explain, without spawning anything, whether a parsed command can run here.
 * @returns {{available: boolean, reason: (string|null), resolved: (string|null)}}
 */
function checkAvailability(parsed, deps) {
  const custom = Boolean(deps && typeof deps.resolve === 'function');
  const resolve = custom ? deps.resolve : defaultResolve;
  // `custom` is passed explicitly: checkAvailability always supplies SOME resolver, so
  // isSpawnable cannot tell a caller-supplied stub from the default by identity alone.
  const probe = isSpawnable(parsed.executable, resolve, custom);
  if (probe.spawnable) return { available: true, reason: null, resolved: probe.resolved };
  const base = path.basename(parsed.executable);
  const suffix = process.platform === 'win32'
    ? ' (on Windows it is a shell alias or a .cmd shim, which cannot be started without cmd.exe)'
    : '';
  // The reason explains WHY, but leaves the caller with nothing to change: retrying the same
  // name is the only move it can think of. Say that the name can never work here, and name
  // the fallbacks — a resolvable program, or a file tool that needs no program at all.
  return {
    available: false,
    reason: '"' + base + '" is allowlisted but this machine has no spawnable binary for it' + suffix
      + '; this name cannot be made to run here, so do not retry it — use a program that has a'
      + ' real .exe on this host (node and git are the safest), or use Read / List / Glob,'
      + ' which need no program',
    resolved: null,
  };
}
function resolveCwd(requested, allowedRoots) {
  const candidate = requested ? path.resolve(requested) : process.cwd();
  // The cwd is a parameter the CALLER passed, so the fix is in its reach: omit it (the
  // workspace root is used) or name a directory that exists.
  if (!fs.existsSync(candidate)) throw new Error('working directory does not exist: ' + candidate
    + '; omit cwd to run in the workspace root, or List to find a directory that exists');
  const stat = fs.statSync(candidate);
  if (!stat.isDirectory()) throw new Error('working directory is not a directory: ' + candidate
    + '; cwd must be a folder — use its parent directory, or omit cwd to run in the workspace'
    + ' root');
  if (allowedRoots && allowedRoots.length) {
    const inside = allowedRoots.some(root => {
      const rel = path.relative(path.resolve(root), candidate);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    });
    // The caller cannot widen the roots; the only fix available to it is to move cwd inside.
    if (!inside) throw new Error('working directory is outside the approved roots: ' + candidate
      + '; use a path inside the workspace, or omit cwd to run in the workspace root');
  }
  return candidate;
}

/**
 * Runs one command. Resolves with a result object; never throws for a command
 * that ran but failed (that is data, not an error).
 */
function runCommand(request, { allowedRoots = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    let cwd;
    try {
      parsed = parseCommand(request.command);
      cwd = resolveCwd(request.cwd, allowedRoots);
    } catch (error) {
      return reject(error);
    }

    // Refuse before spawning, with the real reason. Reaching the spawn only to fail with
    // ENOENT — after the user already approved the command — reads as "approval is broken".
    const availability = checkAvailability(parsed);
    if (!availability.available) {
      return reject(new Error(availability.reason));
    }

    const child = spawn(parsed.executable, parsed.args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let killedForTimeout = false;

    const append = (target, chunk) => {
      const text = chunk.toString('utf8');
      if (target.length + text.length > MAX_OUTPUT_BYTES) {
        truncated = true;
        return target + text.slice(0, Math.max(0, MAX_OUTPUT_BYTES - target.length));
      }
      return target + text;
    };

    child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });

    const timer = setTimeout(() => {
      killedForTimeout = true;
      child.kill();
    }, timeoutMs);

    child.on('error', error => {
      clearTimeout(timer);
      reject(new Error(`failed to start ${parsed.executable}: ${error.message}`));
    });

    child.on('close', code => {
      clearTimeout(timer);
      resolve({
        command: parsed.display,
        cwd,
        exitCode: code,
        stdout,
        stderr,
        truncated,
        timedOut: killedForTimeout,
        ok: code === 0 && !killedForTimeout,
      });
    });
  });
}

module.exports = {
  ALLOWED_EXECUTABLES,
  MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  parseCommand,
  resolveCwd,
  runCommand,
  checkAvailability,
  defaultResolve,
};