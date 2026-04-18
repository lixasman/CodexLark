import test from 'node:test';
import assert from 'node:assert/strict';

test('feishu frame codec round-trips headers and payload', () => {
  const { encodeFeishuFrame, decodeFeishuFrame } = require('../../src/communicate/channel/feishu-frame') as {
    encodeFeishuFrame: (frame: Record<string, unknown>) => Uint8Array;
    decodeFeishuFrame: (buffer: Uint8Array) => Record<string, any>;
  };

  const payload = new TextEncoder().encode(JSON.stringify({ hello: 'world' }));
  const encoded = encodeFeishuFrame({
    SeqID: 11n,
    LogID: 22n,
    service: 321,
    method: 1,
    headers: [
      { key: 'type', value: 'event' },
      { key: 'message_id', value: 'msg-1' },
      { key: 'sum', value: '1' },
      { key: 'seq', value: '0' }
    ],
    payloadEncoding: 'json',
    payloadType: 'application/json',
    payload
  });

  const decoded = decodeFeishuFrame(encoded);
  assert.equal(decoded.SeqID, 11n);
  assert.equal(decoded.LogID, 22n);
  assert.equal(decoded.service, 321);
  assert.equal(decoded.method, 1);
  assert.deepEqual(decoded.headers, [
    { key: 'type', value: 'event' },
    { key: 'message_id', value: 'msg-1' },
    { key: 'sum', value: '1' },
    { key: 'seq', value: '0' }
  ]);
  assert.equal(decoded.payloadEncoding, 'json');
  assert.equal(decoded.payloadType, 'application/json');
  assert.equal(new TextDecoder().decode(decoded.payload), JSON.stringify({ hello: 'world' }));
});
