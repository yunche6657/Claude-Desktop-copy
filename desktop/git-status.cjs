'use strict';
const path = require('node:path');
const { execFile } = require('node:child_process');

function runGit(args, cwd) {
  return new Promise((resolve, reject) => execFile('git', args, {
    cwd, windowsHide: true, encoding: 'utf8', timeout: 30000,
    maxBuffer: 5 * 1024 * 1024,
  }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}

function fieldEnd(record, count) {
  let pos = 0;
  for (let i = 0; i < count; i++) {
    pos = record.indexOf(' ', pos);
    if (pos < 0) return -1;
    pos++;
  }
  return pos;
}

function parseStatus(text) {
  const records = text.split('\0');
  const files = [];
  const paths = new Set();
  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    if (row.startsWith('1 ') || row.startsWith('2 ') || row.startsWith('u ')) {
      const pos = fieldEnd(row, row[0] === '1' ? 8 : row[0] === '2' ? 9 : 10);
      const original = row[0] === '2' ? records[++i] : null;
      if (pos >= 0 && (row[0] !== '2' || original)) {
        paths.add(row.slice(pos));
        files.push({
          status: row.slice(2, 4).replaceAll('.', ' '),
          path: original ? `${original} -> ${row.slice(pos)}` : row.slice(pos),
        });
      }
    } else if (row.startsWith('? ') || row.startsWith('! ')) {
      files.push({ status: row[0].repeat(2), path: row.slice(2) });
      paths.add(row.slice(2));
    }
  }
  return { files, paths };
}

/**
 * Native contracts: index.chunk-C_qk6eGw.js (getLocalBranches/getWorkingTreeStatus).
 * Callers inject the existing workspace policy and trust store, rather than creating
 * a second trust database. Both callbacks may return promises. Missing trust denies.
 */
function createGitStatus({
  isCwdAllowed = () => true,
  isTrusted = () => false,
  run = runGit,
} = {}) {
  const validCwd = cwd => typeof cwd === 'string' && cwd.length > 0 && !cwd.includes('\0') && path.isAbsolute(cwd);
  async function getLocalBranches(cwd) {
    try {
      if (!validCwd(cwd) || !await isCwdAllowed(cwd)) return [];
      if ((await run(['rev-parse', '--is-inside-work-tree'], cwd)).trim() !== 'true') return [];
      const refs = await run(['for-each-ref', '--format=%(refname:strip=2)', 'refs/heads/'], cwd);
      return [...new Set(refs.split(/\r?\n/).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    } catch { return []; }
  }
  async function getWorkingTreeStatus(cwd) {
    try {
      if (!validCwd(cwd) || !await isCwdAllowed(cwd) || !await isTrusted(cwd)) return null;
      const [status, numstat, sparse] = await Promise.all([
        run(['status', '--porcelain=v2', '--branch', '-z'], cwd),
        run(['diff', '--no-textconv', '--numstat', 'HEAD'], cwd).catch(() => ''),
        run(['config', '--bool', 'core.sparseCheckout'], cwd).then(x => x.trim() === 'true', () => false),
      ]);
      const hidden = await run(['ls-files', '-v', '-z', '--full-name', ...(sparse ? ['--sparse'] : []), ':/'], cwd)
        .catch(error => { if (sparse && error.code === 129) return run(['ls-files', '-v', '-z', '--full-name', ':/'], cwd); throw error; });
      const { files, paths: known } = parseStatus(status);
      for (const row of hidden.split('\0')) {
        if (row[1] === ' ' && (/[a-z]/.test(row[0]) || (!sparse && row[0] === 'S'))) {
          const file = row.slice(2);
          if (!known.has(file)) { files.push({ status: ' M', path: file }); known.add(file); }
        }
      }
      let additions = 0, deletions = 0;
      for (const row of numstat.split('\n')) {
        const [added, removed] = row.split('\t');
        if (added && added !== '-') additions += Number(added) || 0;
        if (removed && removed !== '-') deletions += Number(removed) || 0;
      }
      return { files, additions, deletions };
    } catch { return null; }
  }
  return { getLocalBranches, getWorkingTreeStatus };
}

module.exports = { createGitStatus };
