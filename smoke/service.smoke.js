// Smoke tests: exercise the running service over real HTTP rather than calling the
// handler in process. Run with `npm run smoke`.
//
// With SMOKE_BASE_URL set, the tests run against that deployed URL. Without it,
// they start the service locally the way production starts it. Kept out of test/
// so `npm test` stays a fast unit run with no server to boot.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const EXTERNAL_BASE_URL = process.env.SMOKE_BASE_URL;
const PORT = Number(process.env.SMOKE_PORT ?? 4123);
const BASE_URL = (EXTERNAL_BASE_URL ?? `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
const KNOWN_GOOD_ORDER = 'o_1001';

let service;
let output = '';

async function waitForReady(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/orders/${KNOWN_GOOD_ORDER}/total`);
      await res.body?.cancel();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`no answer from ${BASE_URL}: ${lastError?.message}\n${output}`);
}

before(async () => {
  if (!EXTERNAL_BASE_URL) {
    service = spawn(process.execPath, ['--import', './src/instrument.js', 'src/server.js'], {
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    service.stdout.on('data', (chunk) => { output += chunk; });
    service.stderr.on('data', (chunk) => { output += chunk; });
    service.on('exit', (code) => { output += `\nservice exited with code ${code}`; });
  }
  console.log(`smoke target: ${BASE_URL}${EXTERNAL_BASE_URL ? ' (deployed)' : ' (local)'}`);
  await waitForReady();
});

after(() => service?.kill());

test('the health check answers', async () => {
  const res = await fetch(`${BASE_URL}/healthz`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok' });
});

test('the service answers and prices a known-good order', async () => {
  const res = await fetch(`${BASE_URL}/orders/${KNOWN_GOOD_ORDER}/total`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.orderId, KNOWN_GOOD_ORDER);
  assert.equal(typeof body.total, 'number');
  assert.ok(body.total > 0, `expected a positive total, got ${body.total}`);
});

test('an unknown order returns 404 rather than an error', async () => {
  const res = await fetch(`${BASE_URL}/orders/o_does_not_exist/total`);
  await res.body?.cancel();
  assert.equal(res.status, 404);
});

test('an unknown route returns 404', async () => {
  const res = await fetch(`${BASE_URL}/nope`);
  await res.body?.cancel();
  assert.equal(res.status, 404);
});
