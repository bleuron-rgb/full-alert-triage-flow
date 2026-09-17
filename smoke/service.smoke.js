// Smoke tests: start the service the way it starts in production and exercise it
// over real HTTP, rather than calling the handler in process. Run with `npm run smoke`.
// Kept out of test/ so `npm test` stays a fast unit run with no server to boot.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.SMOKE_PORT ?? 4123);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const KNOWN_GOOD_ORDER = 'o_1001';

let service;
let output = '';

async function waitForReady(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/orders/${KNOWN_GOOD_ORDER}/total`);
      await res.body?.cancel();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(`service never answered on ${BASE_URL}. Output so far:\n${output}`);
}

before(async () => {
  service = spawn(process.execPath, ['--import', './src/instrument.js', 'src/server.js'], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  service.stdout.on('data', (chunk) => { output += chunk; });
  service.stderr.on('data', (chunk) => { output += chunk; });
  service.on('exit', (code) => { output += `\nservice exited with code ${code}`; });
  await waitForReady();
});

after(() => service?.kill());

test('the service starts and prices a known-good order', async () => {
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
