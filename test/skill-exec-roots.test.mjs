// A skill you can read but cannot run is only half a skill.
//
// Skills ship executable helpers (docx has scripts/comment.py, pdf has
// scripts/convert_pdf_to_images.py) and those helpers import their siblings, so they
// must run with the skill directory as the working directory. The Bash tool confined
// cwd to allowedRoots, so every one of them was refused with
//   "working directory is outside the approved roots"
// and running one by absolute path from the workspace died on its sibling import.
//
// execRoots widens ONLY the Bash cwd. File reads and writes stay confined to
// allowedRoots -- there is a test below that fails if that ever changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { defineTools } = require(path.join(ROOT, 'desktop', 'tools.cjs'));

/** A workspace plus a skill directory that lives outside it, like the real install. */
function fixture() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'execroots-ws-'));
  const skillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'execroots-skill-'));
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: demo\n---\n\nBody.\n', 'utf8');
  fs.writeFileSync(path.join(skillDir, 'sibling.py'), 'HELPER = "from sibling"\n', 'utf8');
  fs.writeFileSync(path.join(skillDir, 'run.py'), 'from sibling import HELPER\nprint(HELPER)\n', 'utf8');
  return { workspace, skillDir };
}

const hasPython = (() => {
  try {
    require('node:child_process').execFileSync('python', ['--version'], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch { return false; }
})();

test('the Bash cwd can be a skill directory when it is an exec root', { skip: !hasPython }, async () => {
  const { workspace, skillDir } = fixture();
  const tools = defineTools({ workspaceRoot: workspace, allowedRoots: [workspace], execRoots: [workspace, skillDir] });
  const bash = tools.find((entry) => entry.name === 'Bash');
  const result = await bash.handler({ command: 'python --version', cwd: skillDir });
  assert.match(result.content, /Python 3/);
});

test('a skill helper can import its sibling', { skip: !hasPython }, async () => {
  // This is the actual failure mode: the script starts but cannot see the module next to it.
  const { workspace, skillDir } = fixture();
  const tools = defineTools({ workspaceRoot: workspace, allowedRoots: [workspace], execRoots: [workspace, skillDir] });
  const bash = tools.find((entry) => entry.name === 'Bash');
  const result = await bash.handler({ command: 'python run.py', cwd: skillDir });
  assert.match(result.content, /from sibling/);
});

test('exec roots do NOT widen file reads', async () => {
  // If execRoots ever leaks into allowedRoots this fails, which is the point.
  const { workspace, skillDir } = fixture();
  const tools = defineTools({ workspaceRoot: workspace, allowedRoots: [workspace], execRoots: [workspace, skillDir] });
  const read = tools.find((entry) => entry.name === 'Read');
  await assert.rejects(() => read.handler({ path: path.join(skillDir, 'SKILL.md') }), /outside the approved roots/);
});

test('exec roots do NOT widen file writes', async () => {
  const { workspace, skillDir } = fixture();
  const tools = defineTools({ workspaceRoot: workspace, allowedRoots: [workspace], execRoots: [workspace, skillDir] });
  const write = tools.find((entry) => entry.name === 'Write');
  await assert.rejects(() => write.handler({ path: path.join(skillDir, 'x.txt'), content: 'no' }), /outside the approved roots/);
});

test('without exec roots the old confinement still holds', async () => {
  const { workspace, skillDir } = fixture();
  const tools = defineTools({ workspaceRoot: workspace, allowedRoots: [workspace] });
  const bash = tools.find((entry) => entry.name === 'Bash');
  await assert.rejects(() => bash.handler({ command: 'python --version', cwd: skillDir }), /outside the approved roots/);
});
