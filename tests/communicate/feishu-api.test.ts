import test from 'node:test';
import assert from 'node:assert/strict';
import { createFeishuApiClient } from '../../src/communicate/channel/feishu-api';
import {
  createFeishuChannel,
  normalizeFeishuThreadId,
  parseFeishuMessageEvent,
  parseFeishuTextMessageEvent
} from '../../src/communicate/channel/feishu-message';

test('feishu api client fetches tenant token then sends text message to chat_id', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = createFeishuApiClient({
    appId: 'app-id',
    appSecret: 'app-secret',
    fetchImpl: async (url: string | URL | globalThis.Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), init });
      if (String(url).includes('/auth/v3/tenant_access_token/internal')) {
        return new Response(JSON.stringify({ tenant_access_token: 'tenant-token', expire: 7200 }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: 0, data: { message_id: 'om_xxx' } }), { status: 200 });
    }
  });

  await client.sendText({ receiveId: 'oc_123', text: 'hello', receiveIdType: 'chat_id' });

  assert.equal(calls.length, 2);
  assert.match(calls[0]?.url ?? '', /tenant_access_token\/internal/);
  assert.match(calls[1]?.url ?? '', /im\/v1\/messages\?receive_id_type=chat_id/);
  assert.match(String(calls[1]?.init?.headers), /Bearer tenant-token/);
  assert.match(String(calls[1]?.init?.body ?? ''), /hello/);
});

test('feishu api client caches tenant token for repeated sends', async () => {
  let tokenCalls = 0;
  const client = createFeishuApiClient({
    appId: 'app-id',
    appSecret: 'app-secret',
    fetchImpl: async (url: string | URL | globalThis.Request): Promise<Response> => {
      if (String(url).includes('/auth/v3/tenant_access_token/internal')) {
        tokenCalls += 1;
        return new Response(JSON.stringify({ tenant_access_token: 'tenant-token', expire: 7200 }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: 0, data: { message_id: 'om_xxx' } }), { status: 200 });
    }
  });

  await client.sendText({ receiveId: 'oc_123', text: 'hello', receiveIdType: 'chat_id' });
  await client.sendText({ receiveId: 'oc_123', text: 'hello again', receiveIdType: 'chat_id' });

  assert.equal(tokenCalls, 1);
});

test('feishu api client sends interactive card and returns message id', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = createFeishuApiClient({
    appId: 'app-id',
    appSecret: 'app-secret',
    fetchImpl: async (url: string | URL | globalThis.Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), init });
      if (String(url).includes('/auth/v3/tenant_access_token/internal')) {
        return new Response(JSON.stringify({ tenant_access_token: 'tenant-token', expire: 7200 }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: 0, data: { message_id: 'om_card_123' } }), { status: 200 });
    }
  });

  const card = { type: 'template', data: { template_id: 'tpl_status', template_variable: { status: 'RUNNING' } } };
  const messageId = await client.sendCard({ receiveId: 'oc_123', card, receiveIdType: 'chat_id' });

  assert.equal(messageId, 'om_card_123');
  assert.equal(calls.length, 2);
  assert.match(calls[1]?.url ?? '', /im\/v1\/messages\?receive_id_type=chat_id/);
  assert.match(String(calls[1]?.init?.headers), /Bearer tenant-token/);
  const body = JSON.parse(String(calls[1]?.init?.body ?? '{}')) as { receive_id?: string; msg_type?: string; content?: string };
  assert.equal(body.receive_id, 'oc_123');
  assert.equal(body.msg_type, 'interactive');
  assert.deepEqual(JSON.parse(body.content ?? '{}'), card);
});

test('feishu api client updates interactive card by message id', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = createFeishuApiClient({
    appId: 'app-id',
    appSecret: 'app-secret',
    fetchImpl: async (url: string | URL | globalThis.Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), init });
      if (String(url).includes('/auth/v3/tenant_access_token/internal')) {
        return new Response(JSON.stringify({ tenant_access_token: 'tenant-token', expire: 7200 }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 });
    }
  });

  const card = { type: 'template', data: { template_id: 'tpl_status', template_variable: { status: 'DONE' } } };
  await client.updateCard({ messageId: 'om_card_123', card });

  assert.equal(calls.length, 2);
  assert.match(calls[1]?.url ?? '', /im\/v1\/messages\/om_card_123$/);
  assert.equal(calls[1]?.init?.method, 'PATCH');
  assert.match(String(calls[1]?.init?.headers), /Bearer tenant-token/);
  const body = JSON.parse(String(calls[1]?.init?.body ?? '{}')) as { msg_type?: string; content?: string };
  assert.equal(body.msg_type, 'interactive');
  assert.deepEqual(JSON.parse(body.content ?? '{}'), card);
});

test('feishu api client rejects interactive card send when 2xx response body is not json', async () => {
  const client = createFeishuApiClient({
    appId: 'app-id',
    appSecret: 'app-secret',
    fetchImpl: async (url: string | URL | globalThis.Request): Promise<Response> => {
      if (String(url).includes('/auth/v3/tenant_access_token/internal')) {
        return new Response(JSON.stringify({ tenant_access_token: 'tenant-token', expire: 7200 }), { status: 200 });
      }
      return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
    }
  });

  await assert.rejects(
    () => client.sendCard({ receiveId: 'oc_123', card: { type: 'template' }, receiveIdType: 'chat_id' }),
    (error) => {
      assert.match(String(error), /response|json|payload/i);
      return true;
    }
  );
});

test('feishu api client rejects interactive card update when 2xx response body is not json', async () => {
  const client = createFeishuApiClient({
    appId: 'app-id',
    appSecret: 'app-secret',
    fetchImpl: async (url: string | URL | globalThis.Request): Promise<Response> => {
      if (String(url).includes('/auth/v3/tenant_access_token/internal')) {
        return new Response(JSON.stringify({ tenant_access_token: 'tenant-token', expire: 7200 }), { status: 200 });
      }
      return new Response('', { status: 200 });
    }
  });

  await assert.rejects(
    () => client.updateCard({ messageId: 'om_card_123', card: { type: 'template' } }),
    (error) => {
      assert.match(String(error), /response|json|payload/i);
      return true;
    }
  );
});

test('feishu api client reuses in-flight token request for concurrent sendText and sendCard', async () => {
  let tokenCalls = 0;
  let releaseToken: (() => void) | undefined;
  const tokenGate = new Promise<void>((resolve) => {
    releaseToken = resolve;
  });
  const client = createFeishuApiClient({
    appId: 'app-id',
    appSecret: 'app-secret',
    fetchImpl: async (url: string | URL | globalThis.Request): Promise<Response> => {
      if (String(url).includes('/auth/v3/tenant_access_token/internal')) {
        tokenCalls += 1;
        await tokenGate;
        return new Response(JSON.stringify({ tenant_access_token: 'tenant-token', expire: 7200 }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: 0, data: { message_id: 'om_xxx' } }), { status: 200 });
    }
  });

  const textSend = client.sendText({ receiveId: 'oc_123', text: 'hello', receiveIdType: 'chat_id' });
  const cardSend = client.sendCard({ receiveId: 'oc_123', card: { type: 'template' }, receiveIdType: 'chat_id' });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(tokenCalls, 1);

  releaseToken?.();
  await Promise.all([textSend, cardSend]);
});

test('feishu api client downloads image by key', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = createFeishuApiClient({
    appId: 'app-id',
    appSecret: 'app-secret',
    fetchImpl: async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), init });
      if (String(url).includes('/auth/v3/tenant_access_token/internal')) {
        return new Response(JSON.stringify({ tenant_access_token: 'tenant-token', expire: 7200 }), { status: 200 });
      }
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' }
      });
    }
  });

  const result = await client.downloadImage({ imageKey: 'img_abc' });
  assert.equal(result.contentType, 'image/jpeg');
  assert.equal(result.data.byteLength, 3);
  assert.match(calls[1]?.url ?? '', /im\/v1\/images\/img_abc/);
});

test('feishu api client surfaces image download errors with response body', async () => {
  const client = createFeishuApiClient({
    appId: 'app-id',
    appSecret: 'app-secret',
    fetchImpl: async (url: string | URL | Request): Promise<Response> => {
      if (String(url).includes('/auth/v3/tenant_access_token/internal')) {
        return new Response(JSON.stringify({ tenant_access_token: 'tenant-token', expire: 7200 }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: 40001, msg: 'permission denied' }), { status: 400 });
    }
  });

  await assert.rejects(
    () => client.downloadImage({ imageKey: 'img_bad' }),
    (error) => {
      const message = String(error);
      assert.match(message, /400/);
      assert.match(message, /permission denied/);
      return true;
    }
  );
});
test('feishu api client downloads image via message resources when messageId is provided', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = createFeishuApiClient({
    appId: 'app-id',
    appSecret: 'app-secret',
    fetchImpl: async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), init });
      if (String(url).includes('/auth/v3/tenant_access_token/internal')) {
        return new Response(JSON.stringify({ tenant_access_token: 'tenant-token', expire: 7200 }), { status: 200 });
      }
      return new Response(new Uint8Array([9, 8, 7]), {
        status: 200,
        headers: { 'content-type': 'image/png' }
      });
    }
  });

  const result = await client.downloadImage({ imageKey: 'img_abc', messageId: 'om_123' });

  assert.equal(result.contentType, 'image/png');
  assert.equal(result.data.byteLength, 3);
  assert.match(calls[1]?.url ?? '', /im\/v1\/messages\/om_123\/resources\/img_abc[?]type=image/);
});

test('feishu api client resolves file_key via message resources when image_key is rejected', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = createFeishuApiClient({
    appId: 'app-id',
    appSecret: 'app-secret',
    fetchImpl: async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const target = String(url);
      calls.push({ url: target, init });
      if (target.includes('/auth/v3/tenant_access_token/internal')) {
        return new Response(JSON.stringify({ tenant_access_token: 'tenant-token', expire: 7200 }), { status: 200 });
      }
      if (target.includes('/open-apis/im/v1/messages/om_123/resources/img_abc?type=image')) {
        return new Response(JSON.stringify({ code: 234001, msg: 'Invalid request param.' }), { status: 400 });
      }
      if (target.includes('/open-apis/im/v1/messages/om_123/resources?type=image')) {
        return new Response(JSON.stringify({ code: 0, data: { items: [{ file_key: 'file_456' }] } }), { status: 200 });
      }
      if (target.includes('/open-apis/im/v1/messages/om_123/resources/file_456?type=image')) {
        return new Response(new Uint8Array([4, 5, 6]), { status: 200, headers: { "content-type": "image/png" } });
      }
      return new Response("not found", { status: 404 });
    }
  });

  const result = await client.downloadImage({ imageKey: 'img_abc', messageId: 'om_123' });
  assert.equal(result.contentType, "image/png");
  assert.equal(result.data.byteLength, 3);
  assert.match(calls[1]?.url || '', new RegExp('messages/om_123/resources/img_abc\\?type=image'));
  assert.match(calls[2]?.url || '', new RegExp('messages/om_123/resources\\?type=image'));
  assert.match(calls[3]?.url || '', new RegExp('messages/om_123/resources/file_456\\?type=image'));
});
test('parseFeishuMessageEvent extracts image key from im.message.receive_v1 payload', () => {
  const parsed = parseFeishuMessageEvent({
    header: { event_type: 'im.message.receive_v1', token: 'verify-token' },
    event: {
      message: {
        chat_id: 'oc_123',
        message_type: 'image',
        content: JSON.stringify({ image_key: 'img_abc' })
      }
    }
  });

  assert.deepEqual(parsed, {
    threadId: 'feishu:chat:oc_123',
    kind: 'image',
    imageKey: 'img_abc'
  });
});

test('parseFeishuTextMessageEvent extracts threadId and text from im.message.receive_v1 payload', () => {
  const parsed = parseFeishuTextMessageEvent({
    header: {
      event_type: 'im.message.receive_v1',
      token: 'verify-token'
    },
    event: {
      message: {
        chat_id: 'oc_123',
        message_type: 'text',
        content: JSON.stringify({ text: '对 T1 输入: 继续下一步' })
      }
    }
  });

  assert.deepEqual(parsed, {
    threadId: 'feishu:chat:oc_123',
    text: '对 T1 输入: 继续下一步'
  });
});

test('createFeishuChannel maps threadId back to chat_id when sending text', async () => {
  const sent: Array<{ receiveId: string; text: string; receiveIdType: string }> = [];
  const channel = createFeishuChannel({
    sendText: async (payload) => {
      sent.push(payload);
    }
  });

  await channel.sendText('feishu:chat:oc_123', 'done');

  assert.deepEqual(sent, [{ receiveId: 'oc_123', text: 'done', receiveIdType: 'chat_id' }]);
  assert.equal(normalizeFeishuThreadId('oc_123'), 'feishu:chat:oc_123');
});

test('createFeishuChannel maps threadId back to chat_id when sending card', async () => {
  const sent: Array<{ receiveId: string; card: unknown; receiveIdType: string }> = [];
  const channel = createFeishuChannel({
    sendText: async () => {},
    sendCard: async (payload: { receiveId: string; card: unknown; receiveIdType: string }) => {
      sent.push(payload);
      return 'om_card_123';
    }
  });

  const card = { type: 'template', data: { template_id: 'tpl_status' } };
  assert.equal(typeof channel.sendCard, 'function');
  if (!channel.sendCard) throw new Error('sendCard was not exposed');
  const messageId = await channel.sendCard('feishu:chat:oc_123', card);

  assert.equal(messageId, 'om_card_123');
  assert.deepEqual(sent, [{ receiveId: 'oc_123', card, receiveIdType: 'chat_id' }]);
});

test('createFeishuChannel can send card directly to an open_id recipient', async () => {
  const sent: Array<{ receiveId: string; card: unknown; receiveIdType: string }> = [];
  const channel = createFeishuChannel({
    sendText: async () => {},
    sendCard: async (payload: { receiveId: string; card: unknown; receiveIdType: string }) => {
      sent.push(payload);
      return 'om_card_private_123';
    }
  });

  const card = { type: 'template', data: { template_id: 'tpl_status' } };
  assert.equal(typeof channel.sendCardToRecipient, 'function');
  if (!channel.sendCardToRecipient) throw new Error('sendCardToRecipient was not exposed');
  const messageId = await channel.sendCardToRecipient({
    receiveId: 'ou_test_user_1',
    receiveIdType: 'open_id',
    card
  });

  assert.equal(messageId, 'om_card_private_123');
  assert.deepEqual(sent, [{ receiveId: 'ou_test_user_1', card, receiveIdType: 'open_id' }]);
});

test('createFeishuChannel forwards updateCard when client supports it', async () => {
  const updates: Array<{ messageId: string; card: unknown }> = [];
  const channel = createFeishuChannel({
    sendText: async () => {},
    updateCard: async (payload: { messageId: string; card: unknown }) => {
      updates.push(payload);
    }
  });

  const card = { type: 'template', data: { template_id: 'tpl_status', template_variable: { status: 'IDLE' } } };
  assert.equal(typeof channel.updateCard, 'function');
  if (!channel.updateCard) throw new Error('updateCard was not exposed');
  await channel.updateCard('om_card_123', card);

  assert.deepEqual(updates, [{ messageId: 'om_card_123', card }]);
});







