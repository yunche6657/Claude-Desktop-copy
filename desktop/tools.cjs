// Tool registry.
//
// Bridges the agent loop to the executors that already exist and are already
// tested: file-tools (read/write/replace), local-exec (commands), workspace-tree
// (listing). The agent loop knows nothing about any of them; it only sees
// name + schema here and an async execute().
//
// Every tool declares:
//   * an API-facing definition (name, description, input_schema);
//   * the permission action it maps to, so one policy decides approvals;
//   * a handler that returns { content, isError }.
//
// The handlers never prompt. Approval is the caller's job, applied uniformly
// before `handler` runs, which keeps the gate in one place.
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const fileTools = require('./file-tools.cjs');
const { listSkills, readSkillFiles } = require('./local-skills.cjs');

/** The same skills store the bridge and the Skills page read. */
function dataDirForSkills() {
  const workspace = process.env.CLAUDE_WORKSPACE || process.cwd();
  return path.join(workspace, '.data');
}
const { ACTIONS } = require('./permissions.cjs');
const { listDirectory, listTree } = require('./workspace-tree.cjs');
const { runCommand } = require('./local-exec.cjs');

const MAX_TOOL_OUTPUT = 30_000;

function truncate(text) {
  if (typeof text !== 'string') return text;
  if (text.length <= MAX_TOOL_OUTPUT) return text;
  return `${text.slice(0, MAX_TOOL_OUTPUT)}\n… [truncated ${text.length - MAX_TOOL_OUTPUT} characters]`;
}

/** Reads a file and prefixes a 1-based line number to each line, as CLIs do. */
function readWithLineNumbers(filePath, { allowedRoots, offset = 0, limit = 2000 }) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('Read offset must be a nonnegative integer and limit a positive integer');
  }
  const file = fileTools.readFile(filePath, { allowedRoots });
  const lines = file.content.split('\n');
  const rows = [];
  let characters = 0;
  for (let i = offset; i < lines.length && rows.length < limit; i++) {
    const row = `${i + 1}\t${lines[i]}`;
    const size = row.length + (rows.length ? 1 : 0);
    if (rows.length && characters + size > MAX_TOOL_OUTPUT) break;
    rows.push(row);
    characters += size;
  }
  const nextOffset = offset + rows.length < lines.length ? offset + rows.length : null;
  const note = nextOffset !== null
    ? `\n… [${lines.length - nextOffset} more lines; pass offset to continue] (offset=${nextOffset})`
    : '';
  return { path: file.path, content: truncate(rows.join('\n')) + note, totalLines: lines.length,
    returnedLines: rows.length, nextOffset };
}

function defineTools({ workspaceRoot, allowedRoots, execRoots }) {
  // `allowedRoots` bounds file reads and writes. `execRoots` bounds only the working
  // directory a command may run in, which is wider because installed skills ship scripts
  // that must run from their own directory. Keeping the two separate means a skill can be
  // executed without making its directory readable/writable through Read/Write.
  const commandRoots = Array.isArray(execRoots) && execRoots.length ? execRoots : allowedRoots;
  const root = workspaceRoot ? path.resolve(workspaceRoot) : null;
  // "a path is required" named neither the argument the caller must send nor its form; a
  // caller that already sent the key could not tell whether the value was empty, null, or a
  // number. The absolute-path fallback below is left as it was: it already says the repair.
  const resolvePath = requested => {
    if (typeof requested !== 'string' || !requested) {
      throw new Error('a path is required: send the "path" argument as a non-empty string,'
        + ' e.g. {path: "src/index.js"} (absolute paths are also accepted)');
    }
    if (path.isAbsolute(requested)) return requested;
    // Already actionable, so left alone: it names the repair (an absolute path).
    if (!root) throw new Error('no workspace is selected; pass an absolute path');
    return path.join(root, requested);
  };

  return [
    {
      // Skills live in the installed app's own directory, outside the approved workspace
      // roots, so the Read tool refuses them. That left the agent knowing a skill existed
      // (it is listed in the system prompt) but unable to open it — it could only
      // improvise, which is the behaviour the skill exists to replace.
      //
      // This tool takes a SKILL NAME, never a path: the path is resolved here against the
      // skill catalogue, so there is no way to use it to escape the roots. It is READ-only
      // and never prompted, exactly like Read.
      name: 'Skill',
      action: ACTIONS.READ,
      description: 'Read an installed skill: its full instructions and the files it ships with. '
        + 'Call this with no argument to list the skills, or with a skill name to read that skill '
        + 'before doing work that falls inside it.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The skill name, as listed in the system prompt. Omit to list all skills.' },
          file: { type: 'string', description: 'Optional file inside the skill to read instead of SKILL.md.' },
        },
      },
      async handler(input) {
        const catalogue = listSkills(dataDirForSkills());
        if (!input || !input.name) {
          const lines = catalogue.map(skill => `- ${skill.name}: ${skill.description}`);
          return { content: lines.length ? lines.join(String.fromCharCode(10)) : 'No skills are installed.' };
        }
        const wanted = String(input.name).trim().toLowerCase();
        const match = catalogue.find(skill => skill.name.toLowerCase() === wanted)
          || catalogue.find(skill => skill.skillId && String(skill.skillId).toLowerCase() === wanted);
        if (!match) {
          // The list of real names is the repair. With nothing installed there is no list to
          // copy from, and "pass one of those names" would send the caller in a circle — so
          // that case says plainly that no name can work and names the way out.
          const installed = catalogue.map(skill => skill.name).join(', ');
          throw new Error(installed
            ? `No skill named "${input.name}". Installed: ${installed}; pass one of those names`
              + ' exactly, or call Skill with no argument to list them with their descriptions'
            : `No skill named "${input.name}", and no skills are installed — no skill name can`
              + ' work in this workspace; do the task without a skill');
        }
        const files = readSkillFiles(dataDirForSkills(), match.skillId);
        if (!files.length) {
          // Nothing in this skill can be opened, so no follow-up call to Skill can help: name
          // the ceiling and what to do outside it, rather than letting the caller retry.
          throw new Error(`The skill "${match.name}" has no readable files, so its instructions`
            + ' cannot be loaded — do not retry it with a file argument;'
            + ' proceed on your own judgement, or call Skill with no argument to see the'
            + ' other installed skills');
        }
        if (input.file) {
          const rel = String(input.file).replace(/^\.\//, '');
          const found = files.find(entry => entry.path === rel);
          if (!found) {
            // The file list is the repair: the caller passed a plausible name and the exact
            // spellings are what it needs. Say they come from this list, not from a guess.
            throw new Error(`The skill "${match.name}" has no file "${rel}". Files: ${files.map(f => f.path).join(', ')}`
              + '; pass one of those paths exactly (leading "./" is stripped), or omit file to'
              + ' read SKILL.md');
          }
          return { content: truncate(found.content) };
        }
        // SKILL.md first (readSkillFiles already orders it that way), then a file index so
        // the agent knows what else it can ask for.
        const main = files[0];
        const others = files.slice(1).map(entry => entry.path);
        const index = others.length
          ? `\n\nThis skill also ships: ${others.join(', ')}. Pass file to read one.`
          : '';
        return { content: truncate(main.content) + index };
      },
    },
    {
      name: 'Read',
      action: ACTIONS.READ,
      description: 'Read a file from the workspace. Returns the contents with 1-based line numbers.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path, relative to the workspace or absolute.' },
          offset: { type: 'integer', minimum: 0, description: 'First line to read (0-based). Default 0; follow nextOffset for the next page.' },
          limit: { type: 'integer', minimum: 1, description: 'Maximum number of lines. Default 2000.' },
        },
        required: ['path'],
      },
      async handler(input) {
        const result = readWithLineNumbers(resolvePath(input.path), {
          allowedRoots,
          offset: input.offset === undefined ? 0 : input.offset,
          limit: input.limit === undefined ? 2000 : input.limit,
        });
        return result;
      },
    },
    {
      name: 'Write',
      action: ACTIONS.EDIT,
      description: 'Write content to a file, creating it if needed. Overwrites the whole file.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path, relative to the workspace or absolute.' },
          content: { type: 'string', description: 'The complete file contents.' },
        },
        required: ['path', 'content'],
      },
      async handler(input) {
        const result = fileTools.writeFile(resolvePath(input.path), String(input.content ?? ''), { allowedRoots });
        const summary = result.written
          ? `Wrote ${result.path} (+${result.diff.added} −${result.diff.removed})`
          : `${result.path} was already identical; nothing written`;
        return { content: summary };
      },
    },
    {
      name: 'Edit',
      action: ACTIONS.EDIT,
      description: 'Replace one exact occurrence of old_string with new_string in a file.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path, relative to the workspace or absolute.' },
          old_string: { type: 'string', description: 'Exact text to replace; must occur exactly once.' },
          new_string: { type: 'string', description: 'Replacement text.' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
      async handler(input) {
        const result = fileTools.replaceInFile(
          resolvePath(input.path),
          String(input.old_string ?? ''),
          String(input.new_string ?? ''),
          { allowedRoots },
        );
        return { content: `Edited ${result.path} (+${result.diff.added} −${result.diff.removed})` };
      },
    },
    {
      name: 'List',
      action: ACTIONS.READ,
      description: 'List a directory in the workspace. Returns names, types and symlink flags. '
        + 'Use this when you need to know what is directly inside one directory, including '
        + 'subdirectory names; use Glob instead when you need matching files at any depth.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path relative to the workspace. Default ".".' },
        },
      },
      async handler(input) {
        // "no workspace is selected" gave the caller nothing to change. List cannot take an
        // absolute path at all (its argument is relative to the root), so the one usable move
        // is to say that, and to name the tool that does not need a root.
        if (!root) {
          throw new Error('no workspace is selected, so there is no directory to list;'
            + ' List only takes a path relative to the workspace root, so an absolute path'
            + ' cannot help — ask the user to open a folder. The Skill tool still works');
        }
        const relative = input.path && input.path !== '.' ? String(input.path) : '';
        const entries = listDirectory(root, relative);
        if (!entries.length) return { content: '(empty directory)' };
        // "dir name" / "file name": one space, so the marker stays greppable.
        const lines = entries.map(entry => {
          const kind = entry.type === 'directory' ? 'dir' : 'file';
          return `${kind} ${entry.name}${entry.symlink ? ' (symlink)' : ''}`;
        });
        return { content: truncate(lines.join('\n')) };
      },
    },
    {
      name: 'Glob',
      action: ACTIONS.READ,
      // The description carries the guidance, not just the capability.
      //
      // Measured over rounds 174-176: asked to count test/*.test.mjs, the model reached for
      // `ls -1 | wc -l` (refused: pipe) and then `find` (a different program on Windows, silent
      // exit 2) and retried both forever. Told to use Glob, it answered 168/168 in one call with
      // no approval prompt. The reliable path was never hard to use - nothing pointed at it.
      description: 'List workspace files whose path matches a simple glob (*, ?, **). '
        + 'Use this to FIND or COUNT files: totalMatches counts the enumerated matches; '
        + 'follow nextOffset for additional pages. Prefer it over ls/find/wc - those run through the '
        + 'command executor, need approval, and several are unavailable or behave differently '
        + 'on Windows.',
      input_schema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob applied to relative paths, e.g. "src/**/*.js".' },
          max_results: { type: 'integer', minimum: 1, description: 'Maximum matches per page. Default 200.' },
          offset: { type: 'integer', minimum: 0, description: 'Match offset for pagination. Default 0.' },
        },
        required: ['pattern'],
      },
      async handler(input) {
        // Separate sentence from List's on purpose: unlike List, Glob COULD work on an
        // absolute pattern — what it cannot do is search nothing. So the advice differs.
        if (!root) {
          throw new Error('no workspace is selected, so there is no tree to search;'
            + ' a pattern cannot fix this (it is matched against workspace-relative paths) —'
            + ' ask the user to open a folder. The Skill tool still works');
        }
        const pattern = String(input.pattern || '**');
        const limit = input.max_results === undefined ? 200 : input.max_results;
        const offset = input.offset === undefined ? 0 : input.offset;
        if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(offset) || offset < 0) {
          throw new Error('Glob max_results must be a positive integer and offset a nonnegative integer');
        }
        const { entries, truncated } = listTree(root, { maxEntries: 20000 });
        const regex = globToRegExp(pattern);
        const all = entries.filter(entry => entry.type === 'file' && regex.test(entry.path));
        const matches = [];
        let characters = 0;
        for (let i = offset; i < all.length && matches.length < limit; i++) {
          const file = all[i].path;
          const size = file.length + (matches.length ? 1 : 0);
          if (matches.length && characters + size > MAX_TOOL_OUTPUT) break;
          matches.push(file);
          characters += size;
        }
        const nextOffset = offset + matches.length < all.length ? offset + matches.length : null;
        // Say when the list was cut short.
        //
        // Measured: `test/*.test.mjs` matched 201 files and returned 200, silently. The one
        // dropped file sorted last, so a caller asking "does this file exist?" got "no" for a
        // file that was right there. A silent cap turns a complete answer into a wrong one.
        const omitted = Math.max(0, all.length - offset - matches.length);
        const notes = [];
        if (omitted > 0) {
          notes.push('… [' + omitted + ' more ' + (omitted === 1 ? 'match' : 'matches')
            + ' not shown; continue with offset=' + nextOffset + ' or narrow the pattern]');
        }
        // The tree walk itself has a cap, and it is reached before max_results on a large
        // workspace. Measured: 20,050 files returned 1,765 matches with no notice at all,
        // because Glob discarded listTree's `truncated` flag. Raise max_results could not
        // help — the files were never enumerated.
        if (truncated) {
          notes.push('… [the workspace walk was limited by entry count, depth or an unreadable directory;'
            + ' this list may be incomplete]');
        }
        const note = notes.length ? '\n' + notes.join('\n') : '';
        return { content: (matches.length ? matches.join('\n') : all.length ? 'No more files.' : 'No files matched.') + note,
          totalMatches: all.length, returnedCount: matches.length, nextOffset, walkTruncated: truncated };
      },
    },
    {
      name: 'Bash',
      action: ACTIONS.EXEC,
      // Say what it cannot do up front: the caller otherwise learns by trial and error, and
      // each attempt costs an approval prompt.
      description: 'Run one allowlisted command in the workspace and return its output. '
        + 'There is NO shell: pipes (|), redirection, ;, && and backticks are refused, quoted '
        + 'arguments are supported but not expanded, and only a fixed allowlist of programs can '
        + 'start. For file inspection prefer Read / List / Glob, which never need approval.',
      input_schema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command line, e.g. "git status --short".' },
          cwd: { type: 'string', description: 'Working directory; defaults to the workspace root.' },
        },
        required: ['command'],
      },
      async handler(input) {
        const result = await runCommand(
          { command: String(input.command ?? ''), cwd: input.cwd || root || undefined },
          { allowedRoots: commandRoots },
        );
        const parts = [];
        if (result.stdout) parts.push(result.stdout.trimEnd());
        if (result.stderr) parts.push(`[stderr]\n${result.stderr.trimEnd()}`);
        if (!parts.length) parts.push('(no output)');
        parts.push(`[exit ${result.exitCode}${result.timedOut ? ', timed out' : ''}${result.truncated ? ', truncated' : ''}]`);
        return {
          content: truncate(parts.join('\n')),
          isError: !result.ok,
        };
      },
    },
  ];
}

/** Small glob → RegExp, matching the subset the workspace tree already uses. */
function globToRegExp(pattern) {
  let out = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') { i++; out += '(?:.*/)?'; }
        else out += '.*';
      } else out += '[^/]*';
    } else if (ch === '?') out += '[^/]';
    else if ('.+^$()[]{}|\\'.includes(ch)) out += '\\' + ch;
    else out += ch;
  }
  return new RegExp(out + '$');
}

/** The API-facing definitions for a tool set. */
function definitionsFor(tools) {
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema,
  }));
}

module.exports = { defineTools, definitionsFor, globToRegExp, readWithLineNumbers, MAX_TOOL_OUTPUT };
