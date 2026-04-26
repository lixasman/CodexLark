import type { FeishuChannel } from './feishu-client';
import type {
  FeishuChatSendTextInput,
  FeishuSendCardInput,
  FeishuUpdateCardInput
} from './feishu-api';

export function normalizeFeishuThreadId(chatId: string): string {
  return chatId.startsWith('feishu:chat:') ? chatId : `feishu:chat:${chatId}`;
}

export type FeishuMessageEvent =
  | { threadId: string; kind: 'text'; text: string; senderOpenId?: string }
  | { threadId: string; kind: 'image'; imageKey: string };

export type FeishuCardActionEvent =
  | {
      threadId: string;
      messageId?: string;
      eventId?: string;
      traceId?: string;
      frameMessageId?: string;
      cardSource?: 'reply_status_card' | 'approval_card' | 'assistant_reply_receipt';
      kind:
        | 'switch_mode_assistant'
        | 'switch_mode_coding'
        | 'open_task_picker'
        | 'open_takeover_picker'
        | 'create_new_task'
        | 'query_current_task'
        | 'interrupt_stalled_task'
        | 'takeover_picker_prev_page'
        | 'takeover_picker_next_page'
        | 'refresh_takeover_picker'
        | 'confirm_takeover_task'
        | 'return_to_launcher'
        | 'return_to_status'
        | 'close_current_task'
        | 'submit_launch_coding';
      cwd?: string;
      turnId?: string;
    }
  | {
      threadId: string;
      messageId?: string;
      eventId?: string;
      traceId?: string;
      frameMessageId?: string;
      kind: 'pick_current_task' | 'pick_takeover_task';
      taskId: `T${number}`;
    }
  | {
      threadId: string;
      messageId?: string;
      eventId?: string;
      traceId?: string;
      frameMessageId?: string;
      kind: 'select_recent_cwd';
      cwd: string;
    }
  | {
      threadId: string;
      messageId?: string;
      eventId?: string;
      traceId?: string;
      frameMessageId?: string;
      kind: 'allow_waiting_task' | 'deny_waiting_task';
      taskId: `T${number}`;
      cardSource: 'approval_card';
    };

function extractCardFormString(formValue: unknown, key: string): string | undefined {
  if (!formValue || typeof formValue !== 'object') return undefined;
  const raw = (formValue as Record<string, unknown>)[key];
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed ? trimmed : undefined;
  }
  if (raw && typeof raw === 'object') {
    const nested = (raw as Record<string, unknown>).value;
    if (typeof nested === 'string') {
      const trimmed = nested.trim();
      return trimmed ? trimmed : undefined;
    }
  }
  return undefined;
}

function extractTrimmedString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function extractCardActionValue(rawValue: unknown): Record<string, unknown> | undefined {
  if (rawValue && typeof rawValue === 'object') {
    return rawValue as Record<string, unknown>;
  }
  if (typeof rawValue !== 'string') return undefined;
  const trimmed = rawValue.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function parseFeishuMessageEvent(payload: any): FeishuMessageEvent | null {
  if (payload?.header?.event_type !== 'im.message.receive_v1') return null;
  const chatId = payload?.event?.message?.chat_id;
  const messageType = payload?.event?.message?.message_type;
  const content = payload?.event?.message?.content;
  const senderOpenId = payload?.event?.sender?.sender_id?.open_id;
  if (typeof chatId !== 'string' || typeof messageType !== 'string' || typeof content !== 'string') return null;
  try {
    if (messageType === 'text') {
      const parsed = JSON.parse(content) as { text?: string };
      if (typeof parsed.text !== 'string') return null;
      return {
        threadId: normalizeFeishuThreadId(chatId),
        kind: 'text',
        text: parsed.text,
        senderOpenId: typeof senderOpenId === 'string' && senderOpenId.trim() ? senderOpenId.trim() : undefined
      };
    }
    if (messageType === 'image') {
      const parsed = JSON.parse(content) as { image_key?: string };
      if (typeof parsed.image_key !== 'string') return null;
      return { threadId: normalizeFeishuThreadId(chatId), kind: 'image', imageKey: parsed.image_key };
    }
    return null;
  } catch {
    return null;
  }
}

export function parseFeishuTextMessageEvent(payload: any): { threadId: string; text: string } | null {
  const parsed = parseFeishuMessageEvent(payload);
  if (!parsed || parsed.kind !== 'text') return null;
  return { threadId: parsed.threadId, text: parsed.text };
}

export function parseFeishuCardActionEvent(payload: any): FeishuCardActionEvent | null {
  const eventType = extractTrimmedString(payload?.header?.event_type, payload?.header?.eventType);
  if (!eventType?.includes('card.action.trigger')) return null;
  const event = payload?.event;
  const context = event?.context ?? payload?.context;
  const chatId = extractTrimmedString(
    context?.open_chat_id,
    context?.chat_id,
    event?.open_chat_id,
    event?.chat_id,
    payload?.open_chat_id,
    payload?.chat_id
  );
  const messageId = extractTrimmedString(
    context?.open_message_id,
    context?.message_id,
    event?.open_message_id,
    event?.message_id,
    payload?.open_message_id,
    payload?.message_id
  );
  const action = event?.action ?? payload?.action;
  const value = extractCardActionValue(action?.value) ?? extractCardActionValue(action?.option?.value) ?? action?.value;
  const formValue = action?.form_value ?? action?.formValue;
  if (typeof chatId !== 'string' || !action || typeof action !== 'object') return null;
  const cardSource =
    value &&
    typeof value === 'object' &&
    ((value as Record<string, unknown>).cardSource === 'reply_status_card' ||
      (value as Record<string, unknown>).cardSource === 'approval_card' ||
      (value as Record<string, unknown>).cardSource === 'assistant_reply_receipt')
      ? ((value as Record<string, unknown>).cardSource as 'reply_status_card' | 'approval_card' | 'assistant_reply_receipt')
      : undefined;
  const turnId = extractTrimmedString(value && typeof value === 'object' ? (value as Record<string, unknown>).turnId : undefined);
  const kind = extractTrimmedString(
    value && typeof value === 'object' ? (value as Record<string, unknown>).kind : undefined,
    typeof value === 'string' ? value : undefined
  ) ?? '';
  const actionName = typeof action.name === 'string' ? action.name.trim() : '';
  const effectiveKind = kind || actionName;
  if (effectiveKind === 'pick_current_task' || effectiveKind === 'pick_takeover_task') {
    const taskId = extractTrimmedString(value && typeof value === 'object' ? (value as Record<string, unknown>).taskId : undefined) ?? '';
    if (!/^T\d+$/.test(taskId)) return null;
    return {
      threadId: normalizeFeishuThreadId(chatId),
      messageId,
      kind: effectiveKind,
      taskId: taskId as `T${number}`
    };
  }
  if (effectiveKind === 'select_recent_cwd') {
    const cwd = extractTrimmedString(value && typeof value === 'object' ? (value as Record<string, unknown>).cwd : undefined) ?? '';
    if (!cwd) return null;
    return {
      threadId: normalizeFeishuThreadId(chatId),
      messageId,
      kind: 'select_recent_cwd',
      cwd
    };
  }
  if (effectiveKind === 'submit_launch_coding') {
    return {
      threadId: normalizeFeishuThreadId(chatId),
      messageId,
      kind: 'submit_launch_coding',
      cwd: extractCardFormString(formValue, 'project_cwd')
    };
  }
  if (effectiveKind === 'allow_waiting_task' || effectiveKind === 'deny_waiting_task') {
    const taskId = extractTrimmedString(value && typeof value === 'object' ? (value as Record<string, unknown>).taskId : undefined) ?? '';
    if (!/^T\d+$/.test(taskId) || cardSource !== 'approval_card') return null;
    return {
      threadId: normalizeFeishuThreadId(chatId),
      messageId,
      kind: effectiveKind,
      taskId: taskId as `T${number}`,
      cardSource
    };
  }
  if (
    effectiveKind === 'switch_mode_assistant' ||
    effectiveKind === 'switch_mode_coding' ||
    effectiveKind === 'open_task_picker' ||
    effectiveKind === 'open_takeover_picker' ||
    effectiveKind === 'create_new_task' ||
    effectiveKind === 'query_current_task' ||
    effectiveKind === 'interrupt_stalled_task' ||
    effectiveKind === 'takeover_picker_prev_page' ||
    effectiveKind === 'takeover_picker_next_page' ||
    effectiveKind === 'refresh_takeover_picker' ||
    effectiveKind === 'confirm_takeover_task' ||
    effectiveKind === 'return_to_launcher' ||
    effectiveKind === 'return_to_status' ||
    effectiveKind === 'close_current_task'
  ) {
    const base = {
      threadId: normalizeFeishuThreadId(chatId),
      messageId,
      kind: effectiveKind
    };
    if (cardSource === 'assistant_reply_receipt') {
      if (!turnId) return null;
      return { ...base, cardSource, turnId };
    }
    return cardSource ? { ...base, cardSource } : base;
  }
  return null;
}

export function createFeishuChannel(
  client: {
    sendText: (input: FeishuChatSendTextInput) => Promise<void>;
    sendCard?: (input: FeishuSendCardInput) => Promise<string>;
    updateCard?: (input: FeishuUpdateCardInput) => Promise<void>;
  }
): FeishuChannel {
  const resolveChatId = (threadId: string): string => threadId.replace(/^feishu:chat:/, '');
  const channel: FeishuChannel = {
    sendText: async (threadId: string, text: string) => {
      const chatId = resolveChatId(threadId);
      await client.sendText({ receiveId: chatId, text, receiveIdType: 'chat_id' });
    }
  };
  const sendCard = client.sendCard;
  if (sendCard) {
    channel.sendCard = async (threadId: string, card: unknown) => {
      const chatId = resolveChatId(threadId);
      return await sendCard({ receiveId: chatId, card, receiveIdType: 'chat_id' });
    };
    channel.sendCardToRecipient = async ({ receiveId, receiveIdType, card }) => {
      return await sendCard({ receiveId, receiveIdType, card });
    };
  }
  const updateCard = client.updateCard;
  if (updateCard) {
    channel.updateCard = async (messageId: string, card: unknown) => {
      await updateCard({ messageId, card });
    };
  }
  return channel;
}
