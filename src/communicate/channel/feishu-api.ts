export type FeishuReceiveIdType = 'chat_id' | 'user_id' | 'email' | 'union_id' | 'open_id';
export type FeishuSendTextInput = { receiveId: string; text: string; receiveIdType: FeishuReceiveIdType };
export type FeishuSendCardInput = { receiveId: string; card: unknown; receiveIdType: FeishuReceiveIdType };
export type FeishuUpdateCardInput = { messageId: string; card: unknown };
export type FeishuChatSendTextInput = Omit<FeishuSendTextInput, 'receiveIdType'> & { receiveIdType: 'chat_id' };
export type FeishuChatSendCardInput = Omit<FeishuSendCardInput, 'receiveIdType'> & { receiveIdType: 'chat_id' };

export type FeishuApiClient = {
  sendText: (input: FeishuSendTextInput) => Promise<void>;
  sendCard: (input: FeishuSendCardInput) => Promise<string>;
  updateCard: (input: FeishuUpdateCardInput) => Promise<void>;
  downloadImage: (input: { imageKey: string; messageId?: string }) => Promise<{ data: Uint8Array; contentType?: string }>;
};

export function createFeishuApiClient(input: {
  appId: string;
  appSecret: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): FeishuApiClient {
  const fetchImpl = input.fetchImpl ? input.fetchImpl : fetch;
  const baseUrl = (input.baseUrl ? input.baseUrl : 'https://open.feishu.cn').replace(/\/+$/, '');
  let cachedToken: string | null = null;
  let tokenExpiresAt = 0;
  let tokenPromise: Promise<string> | null = null;

  async function readErrorBody(resp: Response): Promise<string> {
    try {
      return await resp.text();
    } catch {
      return '';
    }
  }
  function parseErrorCode(errorBody: string): number | undefined {
    if (!errorBody) return undefined;
    try {
      const payload = JSON.parse(errorBody) as { code?: number };
      return typeof payload.code === 'number' ? payload.code : undefined;
    } catch {
      return undefined;
    }
  }

  function collectResourceKeys(data: unknown): string[] {
    const keys: string[] = [];
    const candidates: unknown[] = [];
    if (Array.isArray(data)) {
      candidates.push(...data);
    } else if (data && typeof data === 'object') {
      const record = data as Record<string, unknown>;
      if (Array.isArray(record.items)) candidates.push(...record.items);
      if (Array.isArray(record.resources)) candidates.push(...record.resources);
      if (Array.isArray(record.files)) candidates.push(...record.files);
    }
    for (const item of candidates) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const key = record.file_key ?? record.fileKey ?? record.key;
      if (typeof key === 'string' && key.trim()) {
        keys.push(key);
      }
    }
    return keys;
  }

  function pickResourceKey(keys: string[], preferred: string): string | undefined {
    if (keys.length === 0) return undefined;
    if (keys.includes(preferred)) return preferred;
    if (keys.length === 1) return keys[0];
    return undefined;
  }

  async function listMessageResourceKeys(messageId: string, type: 'image'): Promise<string[]> {
    const token = await getTenantAccessToken();
    const resp = await fetchImpl(`${baseUrl}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources?type=${type}`, {
      method: 'GET',
      headers: [['authorization', `Bearer ${token}`]]
    });
    const payload = await resp.json().catch(() => undefined) as { code?: number; data?: unknown } | undefined;
    if (!resp.ok || payload?.code !== 0) {
      const suffix = payload ? ` ${JSON.stringify(payload)}` : '';
      throw new Error(`Failed to fetch Feishu message resources: ${resp.status}${suffix}`);
    }
    return collectResourceKeys(payload.data);
  }

  async function readJsonPayload<T>(resp: Response, context: string): Promise<T> {
    try {
      return await resp.json() as T;
    } catch {
      throw new Error(`Failed to ${context}: ${resp.status} invalid JSON response`);
    }
  }

  async function getTenantAccessToken(): Promise<string> {
    if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
    if (tokenPromise) return tokenPromise;
    const request = (async (): Promise<string> => {
      const resp = await fetchImpl(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app_id: input.appId, app_secret: input.appSecret })
      });
      const payload = await readJsonPayload<{ tenant_access_token?: string; expire?: number }>(
        resp,
        'obtain Feishu tenant access token'
      );
      if (!resp.ok || !payload.tenant_access_token) {
        throw new Error('Failed to obtain Feishu tenant access token');
      }
      cachedToken = payload.tenant_access_token;
      tokenExpiresAt = Date.now() + Math.max(60, (payload.expire ? payload.expire : 7200) - 60) * 1_000;
      return cachedToken;
    })();
    tokenPromise = request;
    try {
      return await request;
    } finally {
      if (tokenPromise === request) tokenPromise = null;
    }
  }

  async function sendMessage(input: {
    receiveId: string;
    receiveIdType: FeishuReceiveIdType;
    msgType: 'text' | 'interactive';
    content: unknown;
  }): Promise<{ messageId?: string }> {
    const token = await getTenantAccessToken();
    const resp = await fetchImpl(`${baseUrl}/open-apis/im/v1/messages?receive_id_type=${input.receiveIdType}`, {
      method: 'POST',
      headers: [
        ['content-type', 'application/json'],
        ['authorization', `Bearer ${token}`]
      ],
      body: JSON.stringify({
        receive_id: input.receiveId,
        msg_type: input.msgType,
        content: JSON.stringify(input.content)
      })
    });
    const payload = await readJsonPayload<{ code?: number; data?: { message_id?: string } }>(
      resp,
      `send Feishu ${input.msgType} message`
    );
    if (!resp.ok || payload.code !== 0) {
      const suffix = ` ${JSON.stringify(payload)}`;
      throw new Error(`Failed to send Feishu ${input.msgType} message: ${resp.status}${suffix}`);
    }
    return { messageId: payload.data?.message_id };
  }

  return {
    sendText: async ({ receiveId, text, receiveIdType }) => {
      await sendMessage({ receiveId, receiveIdType, msgType: 'text', content: { text } });
    },
    sendCard: async ({ receiveId, card, receiveIdType }) => {
      const result = await sendMessage({ receiveId, receiveIdType, msgType: 'interactive', content: card });
      if (!result.messageId) {
        throw new Error('Failed to send Feishu interactive message: missing message_id');
      }
      return result.messageId;
    },
    updateCard: async ({ messageId, card }) => {
      const token = await getTenantAccessToken();
      const resp = await fetchImpl(`${baseUrl}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
        method: 'PATCH',
        headers: [
          ['content-type', 'application/json'],
        ['authorization', `Bearer ${token}`]
      ],
      body: JSON.stringify({ msg_type: 'interactive', content: JSON.stringify(card) })
    });
      const payload = await readJsonPayload<{ code?: number }>(
        resp,
        'update Feishu interactive message'
      );
      if (!resp.ok || payload.code !== 0) {
        const suffix = ` ${JSON.stringify(payload)}`;
        throw new Error(`Failed to update Feishu interactive message: ${resp.status}${suffix}`);
      }
    },
    downloadImage: async ({ imageKey, messageId }) => {
      const token = await getTenantAccessToken();

      const attemptDownload = async (fileKey: string): Promise<Response> => {
        const endpoint = messageId
          ? `${baseUrl}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}?type=image`
          : `${baseUrl}/open-apis/im/v1/images/${encodeURIComponent(fileKey)}`;
        return await fetchImpl(endpoint, {
          method: 'GET',
          headers: [['authorization', `Bearer ${token}`]]
        });
      };

      let resp = await attemptDownload(imageKey);
      if (!resp.ok) {
        const errorBody = await readErrorBody(resp);
        const errorCode = parseErrorCode(errorBody);
        if (messageId && errorCode === 234001) {
          const resourceKeys = await listMessageResourceKeys(messageId, 'image');
          const resolvedKey = pickResourceKey(resourceKeys, imageKey);
          if (resolvedKey && resolvedKey !== imageKey) {
            resp = await attemptDownload(resolvedKey);
            if (resp.ok) {
              const data = new Uint8Array(await resp.arrayBuffer());
              const headerContentType = resp.headers.get('content-type');
              const contentType = headerContentType ? headerContentType : undefined;
              return { data, contentType };
            }
            const fallbackBody = await readErrorBody(resp);
            const fallbackSuffix = fallbackBody ? ` ${fallbackBody}` : '';
            throw new Error(`Failed to download Feishu image: ${resp.status}${fallbackSuffix}`);
          }
        }
        const suffix = errorBody ? ` ${errorBody}` : '';
        throw new Error(`Failed to download Feishu image: ${resp.status}${suffix}`);
      }
      const data = new Uint8Array(await resp.arrayBuffer());
      const headerContentType = resp.headers.get('content-type');
      const contentType = headerContentType ? headerContentType : undefined;
      return { data, contentType };
    }
  };
}


