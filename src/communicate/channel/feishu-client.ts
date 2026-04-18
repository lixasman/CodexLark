import type { FeishuReceiveIdType } from './feishu-api';

export type FeishuChannel = {
  sendText: (threadId: string, text: string) => Promise<void>;
  sendCard?: (threadId: string, card: unknown) => Promise<string>;
  sendCardToRecipient?: (input: { receiveId: string; receiveIdType: FeishuReceiveIdType; card: unknown }) => Promise<string>;
  updateCard?: (messageId: string, card: unknown) => Promise<void>;
};

