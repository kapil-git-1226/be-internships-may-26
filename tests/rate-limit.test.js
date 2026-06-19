import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import http from 'node:http';

test('rate limit: allow 5 per minute, 6th is 429', async () => {
  const PORT = '9092';
  const DB_FILE = `./data/test-rl-1-${Date.now()}.db`;
  const ENV = { ...process.env, API_KEY: 'k', PORT, DATABASE_URL: DB_FILE, RATE_LIMIT_PER_MIN: '5' };

  const proc = spawn('node', ['src/server.js'], { env: ENV });
  await wait(800);

  try {
    const base = `http://localhost:${PORT}`;
    const statuses = [];

    for (let i = 0; i < 6; i++) {
      const code = await postStatus(`${base}/v1/signals`, {
        headers: { 'x-api-key': 'k' },
        body: { userId: 'rl-user', type: 'note', payload: String(i) },
      });
      statuses.push(code);
    }

    const counts = statuses.reduce((acc, c) => ((acc[c] = (acc[c] || 0) + 1), acc), {});
    assert.ok((counts[201] || 0) + (counts[200] || 0) >= 5, `Expected at least 5 success responses, got: ${JSON.stringify(counts)}`);
    assert.ok(counts[429] >= 1, `Expected at least one 429 response, got: ${JSON.stringify(counts)}`);
  } finally {
    proc.kill();
    await wait(200);
  }
});

test('rate limit: different userIds have independent buckets', async () => {
  const PORT = '9095';
  const DB_FILE = `./data/test-rl-2-${Date.now()}.db`;
  const ENV = { ...process.env, API_KEY: 'k', PORT, DATABASE_URL: DB_FILE, RATE_LIMIT_PER_MIN: '5' };

  const proc = spawn('node', ['src/server.js'], { env: ENV });
  await wait(800);

  try {
    const base = `http://localhost:${PORT}`;
    const results = {};

    for (const uid of ['user-a', 'user-b']) {
      results[uid] = [];
      for (let i = 0; i < 5; i++) {
        const code = await postStatus(`${base}/v1/signals`, {
          headers: { 'x-api-key': 'k' },
          body: { userId: uid, type: 'note', payload: String(i) },
        });
        results[uid].push(code);
      }
    }

    const aFails = results['user-a'].filter((c) => c === 429).length;
    const bFails = results['user-b'].filter((c) => c === 429).length;
    assert.equal(aFails, 0, 'user-a should not be rate limited within 5 requests');
    assert.equal(bFails, 0, 'user-b should not be rate limited within 5 requests');
  } finally {
    proc.kill();
    await wait(200);
  }
});

test('rate limit: concurrent burst does not allow more than RATE requests', async () => {
  const PORT = '9096';
  const DB_FILE = `./data/test-rl-3-${Date.now()}.db`;
  const ENV = { ...process.env, API_KEY: 'k', PORT, DATABASE_URL: DB_FILE, RATE_LIMIT_PER_MIN: '5' };

  const proc = spawn('node', ['src/server.js'], { env: ENV });
  await wait(800);

  try {
    const base = `http://localhost:${PORT}`;

    const statuses = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        postStatus(`${base}/v1/signals`, {
          headers: { 'x-api-key': 'k' },
          body: { userId: 'burst-user', type: 'note', payload: String(i) },
        })
      )
    );

    const counts = statuses.reduce((acc, c) => ((acc[c] = (acc[c] || 0) + 1), acc), {});
    const successCount = (counts[200] || 0) + (counts[201] || 0);
    assert.ok(
      successCount <= 5,
      `Concurrent burst must not exceed rate limit (5), got ${successCount} successes. Statuses: ${JSON.stringify(counts)}`
    );
    assert.ok(
      (counts[429] || 0) >= 5,
      `Expected at least 5 rate-limited responses. Got: ${JSON.stringify(counts)}`
    );
  } finally {
    proc.kill();
    await wait(200);
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function postStatus(url, { headers, body }) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}
