// R482: a gateway credential bypasses the /login gate. Proven by moving the failure, not by succeeding.
//
// THE QUESTION LEFT OPEN BY R481
//   The frontend composer sends, the CLI answers, and the answer is
//       {"type":"result","is_error":true,"result":"Not logged in · Please run /login"}
//   so the frontend view cannot reply without credentials. The open question was whether the gateway
//   path in desktop/ccb-kernel.cjs is a real alternative to a subscription login.
//
// WHAT THE KERNEL INTENDS (writeGatewaySettings)
//       const baseUrl = base.ANTHROPIC_BASE_URL;
//       const token   = base.ANTHROPIC_AUTH_TOKEN || base.ANTHROPIC_API_KEY;
//       if (!baseUrl || !token) return null;
//       write { env: { ANTHROPIC_BASE_URL, ANTHROPIC_MODEL } }  ->  --settings <file>
//   The settings file carries the URL only; the TOKEN travels in the environment. So the gateway path
//   needs both, in different places.
//
// HOW IT WAS TESTED — three arms, identical protocol, only the credential shape differs
//   A. no BASE_URL, no token                  -> "Not logged in"
//   B. BASE_URL to a dead loopback + a token   -> ?
//   C. same, plus the --settings file          -> ?
//
//   A dead loopback (127.0.0.1:9, discard port) is deliberate: no real credential, no egress, yet it
//   separates "refused for lack of credentials" from "accepted the credentials and then could not reach
//   the endpoint". Only the second outcome proves the gate can be satisfied.
//
// THE RESULT
//   A: 4 stdout lines, result frame with is_error true, "Not logged in · Please run /login"   (R481)
//   B: 9 stdout lines, NO result frame, and instead
//          {"type":"system","subtype":"api_retry","attempt":1,"max_retries":10,
//           "retry_delay_ms":504, "error_status":null, "error":"unknown"}
//        repeating to attempt 7 with retry_delay_ms 38712 — exponential backoff against the dead port.
//   C: identical to B. Same retry sequence, same absence of a result frame.
//
//   The login gate is GONE in B and C. The failure moved from the auth layer to the network layer, and
//   the CLI is now retrying an HTTP request it cannot deliver. That is the proof: with a BASE_URL and a
//   token present, the CLI stops demanding /login and starts issuing API calls.
//
//   C matching B also shows the --settings file is not what flips the gate — the environment is. The
//   settings file only routes the URL; the token must be in the environment, exactly as
//   writeGatewaySettings implies by omitting it from the file.
//
// WHAT THIS MEANS FOR THE DELIVERY
//   The frontend view's missing replies are a credential problem with a known, supported solution:
//   supply ANTHROPIC_BASE_URL plus ANTHROPIC_AUTH_TOKEN (or ANTHROPIC_API_KEY) through the gateway
//   configuration, and the CLI will call that endpoint instead of refusing. No code change is needed —
//   the kernel already writes the settings file and passes it.
//
//   Not proven here: that a WORKING endpoint produces a reply. That needs a live provider, which this
//   round deliberately does not have.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.resolve(ROOT, '..', '.tmp');
const CAP = path.join(TMP, 'gateway-probe-r482.json');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const armByName = (cap, name) => (cap.arms || []).find((a) => a.label === name);

test('without credentials the CLI refuses at the login gate', (t) => {
  if (!fs.existsSync(CAP)) {
    t.skip('capture absent — run .tmp/gateway-probe-r482.cjs');
    return;
  }
  const cap = JSON.parse(read(CAP));
  const arm = armByName(cap, 'A-no-creds');
  assert.ok(arm, 'arm A is missing from the capture');

  assert.equal(arm.spawned, true, 'the CLI did not spawn in arm A');
  assert.equal(arm.gotControlResponse, true, 'the handshake failed in arm A, so this is not an auth story');
  assert.ok(arm.result, 'no result frame in arm A');
  assert.equal(arm.result.is_error, true, 'arm A did not report an error');
  assert.match(String(arm.result.result), /Not logged in/,
    'the refusal wording changed: ' + String(arm.result.result).slice(0, 160));
});

test('with a BASE_URL and a token the login gate is gone', (t) => {
  if (!fs.existsSync(CAP)) {
    t.skip('capture absent');
    return;
  }
  const cap = JSON.parse(read(CAP));
  const arm = armByName(cap, 'B-token-only');
  assert.ok(arm, 'arm B is missing from the capture');

  assert.equal(arm.spawned, true, 'the CLI did not spawn in arm B');
  assert.equal(arm.gotControlResponse, true, 'the handshake failed in arm B');

  // The decisive negative: no auth refusal anywhere in the output.
  const allOutput = [...(arm.stdout || []), ...(arm.stderr || [])].join('\n');
  assert.ok(!/Not logged in/.test(allOutput),
    'arm B still complains about being logged out, so the gateway claim does not hold');
  assert.ok(!arm.result,
    'arm B produced a result frame; with a dead endpoint it should still be retrying, so re-derive '
    + 'what happened: ' + JSON.stringify(arm.result));

  // And the decisive positive: it moved on to making API calls.
  const retries = (arm.stdout || []).filter((l) => /"subtype":"api_retry"/.test(l));
  assert.ok(retries.length >= 3,
    `expected repeated api_retry frames, saw ${retries.length}`);

  // The retry frames must be well formed enough to show backoff, which is what proves a real HTTP
  // request is being attempted rather than a stub.
  const delays = retries.map((l) => {
    try { return JSON.parse(l).retry_delay_ms; } catch { return null; }
  }).filter((d) => typeof d === 'number');
  assert.ok(delays.length >= 3, 'retry frames carry no retry_delay_ms');
  assert.ok(delays[delays.length - 1] > delays[0],
    `retry delays are not increasing: ${JSON.stringify(delays)}`);
});

test('the settings file does not change the gate — the environment does', (t) => {
  if (!fs.existsSync(CAP)) {
    t.skip('capture absent');
    return;
  }
  const cap = JSON.parse(read(CAP));
  const b = armByName(cap, 'B-token-only');
  const c = armByName(cap, 'C-with-settings');
  assert.ok(b && c, 'arms B and C are both required for this comparison');

  // C must behave like B: the same absence of a result, the same retry behaviour. If C differed, the
  // "settings file is only for the URL" reading would be wrong.
  assert.equal(!!c.result, !!b.result,
    'arm C produced a result frame where arm B did not: the settings file changes the gate');

  const retriesB = (b.stdout || []).filter((l) => /"subtype":"api_retry"/.test(l)).length;
  const retriesC = (c.stdout || []).filter((l) => /"subtype":"api_retry"/.test(l)).length;
  assert.ok(retriesC >= 3, `arm C only retried ${retriesC} times`);
  assert.ok(Math.abs(retriesC - retriesB) <= 3,
    `arm C and arm B diverged (${retriesC} vs ${retriesB} retries): the settings file is doing more `
    + 'than routing the URL');

  // And the settings file the kernel would write really does omit the token.
  const written = (cap.settingsFile && cap.settingsFile.contents) || '';
  assert.match(written, /ANTHROPIC_BASE_URL/, 'the settings file does not carry the base URL');
  assert.ok(!/AUTH_TOKEN|API_KEY/.test(written),
    'the settings file now carries a token: writeGatewaySettings must have changed, which changes '
    + 'where credentials are expected');
});

test('writeGatewaySettings still requires both URL and token', () => {
  // The probe's design rests on this early return: no URL or no token means no settings file at all.
  const kernel = read(ROOT, 'desktop', 'ccb-kernel.cjs');
  assert.match(kernel, /ANTHROPIC_AUTH_TOKEN\s*\|\|\s*base\.ANTHROPIC_API_KEY/,
    'the token source changed: re-derive which variable the gateway path needs');
  assert.match(kernel, /if \(!baseUrl \|\| !token\) return null/,
    'the URL+token precondition changed');
  assert.match(kernel, /--settings/,
    'the kernel no longer passes --settings, so the settings file would never reach the CLI');
});
