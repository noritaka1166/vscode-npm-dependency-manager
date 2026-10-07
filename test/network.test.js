const test = require('node:test');
const assert = require('node:assert/strict');
const { getEventListeners } = require('node:events');
const { NetworkClient } = require('../lib/network');

function mockFetch(t, handler) {
  const original = global.fetch;
  global.fetch = handler;
  t.after(() => { global.fetch = original; });
}

test('応答ヘッダーを待つ通信をタイムアウトし、signalとリスナーを片付ける', async (t) => {
  let signal;
  mockFetch(t, async (_, options) => {
    signal = options.signal;
    return new Promise(() => {});
  });
  const network = new NetworkClient({ timeoutMs: 5 });
  await assert.rejects(network.json('https://example.test'), { name: 'TimeoutError' });
  assert(signal.aborted);
  assert.equal(getEventListeners(network.controller.signal, 'abort').length, 0);
});

test('応答本文の読み取りにもタイムアウトを適用する', async (t) => {
  let signal;
  mockFetch(t, async (_, options) => {
    signal = options.signal;
    return { ok: true, text: () => new Promise(() => {}) };
  });
  const network = new NetworkClient({ timeoutMs: 5 });
  await assert.rejects(network.text('https://example.test'), { name: 'TimeoutError' });
  assert(signal.aborted);
});

test('複数の通信をまとめてキャンセルし、新しい通信も開始しない', async (t) => {
  const signals = [];
  mockFetch(t, async (_, options) => {
    signals.push(options.signal);
    return new Promise(() => {});
  });
  const network = new NetworkClient();
  const first = network.json('https://example.test/a');
  const second = network.text('https://example.test/b');
  const checks = [first, second].map((request) => assert.rejects(request, { name: 'AbortError' }));
  network.cancel();
  await Promise.all(checks);
  assert(signals.every((signal) => signal.aborted));
  await assert.rejects(network.json('https://example.test/c'), { name: 'AbortError' });
  assert.equal(signals.length, 2);
  assert.equal(getEventListeners(network.controller.signal, 'abort').length, 0);
});

test('正常終了とHTTPエラー後も中断リスナーを残さない', async (t) => {
  mockFetch(t, async () => ({ ok: true, json: async () => ({ value: 1 }) }));
  const network = new NetworkClient();
  assert.deepEqual(await network.json('https://example.test'), { value: 1 });
  assert.equal(getEventListeners(network.controller.signal, 'abort').length, 0);
  global.fetch = async () => ({ ok: false, status: 503 });
  await assert.rejects(network.json('https://example.test'), /HTTP 503/);
  assert.equal(getEventListeners(network.controller.signal, 'abort').length, 0);
});
