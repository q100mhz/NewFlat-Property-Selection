import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fetch } from 'undici';
import { createAgent, preferredAddress } from '../src/net.js';

// 10.255.255.1 — немаршрутизируемый адрес: соединение с ним зависает, как с недоступным адресом Битрикс24
test('подключение перебирает адреса и запоминает рабочий', async () => {
  const server = http.createServer((_req, res) => res.end('ok'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const resolve = (_host, cb) => cb(null, [
    { address: '10.255.255.1', family: 4 },
    { address: '10.255.255.2', family: 4 },
    { address: '127.0.0.1', family: 4 },
  ]);
  const agent = createAgent(resolve);
  try {
    let t = Date.now();
    const r1 = await fetch(`http://portal.test:${port}/`, { dispatcher: agent });
    assert.equal(await r1.text(), 'ok');
    const first = Date.now() - t;
    assert.equal(preferredAddress.get('portal.test'), '127.0.0.1');

    await agent.close();
    const agent2 = createAgent(resolve);
    t = Date.now();
    const r2 = await fetch(`http://portal.test:${port}/`, { dispatcher: agent2 });
    assert.equal(await r2.text(), 'ok');
    const second = Date.now() - t;
    await agent2.close();
    assert.ok(second < 500, `повторное подключение сразу на рабочий адрес (${second} мс, первое ${first} мс)`);
  } finally {
    server.close();
  }
});
