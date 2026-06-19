import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import http from 'node:http';

test('idempotency: same key returns same resource', async () => {
  const PORT = '9091';
  const DB_FILE = `./data/test-idem-1-${Date.now()}.db`;
  const ENV = { ...process.env, API_KEY: 'k', PORT, DATABASE_URL: DB_FILE };

  const proc = spawn('node', ['src/server.js'], { env: ENV });
  await wait(800);

  try {
    const base = `http://localhost:${PORT}`;
    const idem = `idem-${Date.now()}`;

    const a = await postJson(`${base}/v1/signals`, {
      headers: { 'x-api-key': 'k', 'idempotency-key': idem },
      body: { userId: 'u1', type: 'note', payload: 'x' },
    });

    const b = await postJson(`${base}/v1/signals`, {
      headers: { 'x-api-key': 'k', 'idempotency-key': idem },
      body: { userId: 'u1', type: 'note', payload: 'x' },
    });

    assert.equal(a.id, b.id, 'ids must match on duplicate idempotency-key');
    assert.equal(a.idempotencyKey, b.idempotencyKey, 'idempotencyKey must match');
    assert.equal(a.idempotencyKey, idem, 'idempotencyKey must equal the sent key');
  } finally {
    proc.kill();
    await wait(200);
  }
});

test('idempotency: concurrent requests with same key produce one row', async () => {
  const PORT = '9093';
  const DB_FILE = `./data/test-idem-2-${Date.now()}.db`;
  const ENV = { ...process.env, API_KEY: 'k', PORT, DATABASE_URL: DB_FILE, RATE_LIMIT_PER_MIN: '50' };

  const proc = spawn('node', ['src/server.js'], { env: ENV });
  await wait(800);

  try {
    const base = `http://localhost:${PORT}`;
    const idem = `concurrent-${Date.now()}`;

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        postJson(`${base}/v1/signals`, {
          headers: { 'x-api-key': 'k', 'idempotency-key': idem },
          body: { userId: 'u2', type: 'burst', payload: 'p' },
        })
      )
    );

    const ids = results.map((r) => r.id);
    const uniqueIds = new Set(ids);
    assert.equal(uniqueIds.size, 1, `All concurrent responses must share one id, got: ${JSON.stringify(ids)}`);
  } finally {
    proc.kill();
    await wait(200);
  }
});

test('idempotency: no key creates independent rows', async () => {
  const PORT = '9094';
  const DB_FILE = `./data/test-idem-3-${Date.now()}.db`;
  const ENV = { ...process.env, API_KEY: 'k', PORT, DATABASE_URL: DB_FILE };

  const proc = spawn('node', ['src/server.js'], { env: ENV });
  await wait(800);

  try {
    const base = `http://localhost:${PORT}`;

    const a = await postJson(`${base}/v1/signals`, {
      headers: { 'x-api-key': 'k' },
      body: { userId: 'u3', type: 'note', payload: 'y' },
    });
    const b = await postJson(`${base}/v1/signals`, {
      headers: { 'x-api-key': 'k' },
      body: { userId: 'u3', type: 'note', payload: 'y' },
    });

    assert.notEqual(a.id, b.id, 'Without idempotency key, two inserts must create two rows');
  } finally {
    proc.kill();
    await wait(200);
  }
});

test('db failures: server retries on simulated transient failures and succeeds', async () => {
  const PORT = '9097';
  const DB_FILE = `./data/test-fail-${Date.now()}.db`;
  
  // Set DB_FAIL_RATE to 0.3 (30% probability of transient db failures)
  const ENV = { ...process.env, API_KEY: 'k', PORT, DATABASE_URL: DB_FILE, DB_FAIL_RATE: '0.3' };

  const proc = spawn('node', ['src/server.js'], { env: ENV });
  await wait(800);

  try {
    const base = `http://localhost:${PORT}`;

    // Send multiple requests. With 50% fail rate, some are guaranteed to trigger errors,
    // but the retry wrapper should make them all succeed transparently.
    for (let i = 0; i < 5; i++) {
      const res = await postJson(`${base}/v1/signals`, {
        headers: { 'x-api-key': 'k' },
        body: { userId: `user-fail-${i}`, type: 'note', payload: 'data' },
      });
      assert.ok(res.id, `Request ${i} should have succeeded and returned an ID despite transient failures`);
    }
  } finally {
    proc.kill();
    await wait(200);
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function postJson(url, { headers, body }) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers },
      },
      (res) => {
        let chunks = '';
        res.on('data', (d) => (chunks += d));
        res.on('end', () => {
          try {
            resolve(JSON.parse(chunks || '{}'));
          } catch (e) {
            console.error('Failed to parse response JSON. Raw chunks:', chunks);
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}
