import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFeishuCardActionEvent } from '../../src/communicate/channel/feishu-message';

test('parseFeishuCardActionEvent preserves reply status card source metadata', () => {
  const action = parseFeishuCardActionEvent({
    header: { event_type: 'card.action.trigger' },
    event: {
      context: {
        open_chat_id: 'oc_test_chat_1',
        open_message_id: 'om_reply_card_1'
      },
      action: {
        value: {
          kind: 'query_current_task',
          cardSource: 'reply_status_card'
        }
      }
    }
  });

  assert.deepEqual(action, {
    threadId: 'feishu:chat:oc_test_chat_1',
    messageId: 'om_reply_card_1',
    kind: 'query_current_task',
    cardSource: 'reply_status_card'
  });
});

test('parseFeishuCardActionEvent recognizes stalled-task interrupt callbacks', () => {
  const action = parseFeishuCardActionEvent({
    header: { event_type: 'card.action.trigger' },
    event: {
      context: {
        open_chat_id: 'oc_test_chat_1',
        open_message_id: 'om_reply_card_2'
      },
      action: {
        value: {
          kind: 'interrupt_stalled_task',
          cardSource: 'reply_status_card'
        }
      }
    }
  });

  assert.deepEqual(action, {
    threadId: 'feishu:chat:oc_test_chat_1',
    messageId: 'om_reply_card_2',
    kind: 'interrupt_stalled_task',
    cardSource: 'reply_status_card'
  });
});

test('parseFeishuCardActionEvent recognizes approval-card allow callbacks', () => {
  const action = parseFeishuCardActionEvent({
    header: { event_type: 'card.action.trigger' },
    event: {
      context: {
        open_chat_id: 'oc_test_chat_2',
        open_message_id: 'om_approval_card_1'
      },
      action: {
        value: {
          kind: 'allow_waiting_task',
          taskId: 'T26',
          cardSource: 'approval_card'
        }
      }
    }
  });

  assert.deepEqual(action, {
    threadId: 'feishu:chat:oc_test_chat_2',
    messageId: 'om_approval_card_1',
    kind: 'allow_waiting_task',
    taskId: 'T26',
    cardSource: 'approval_card'
  });
});

test('parseFeishuCardActionEvent preserves assistant receipt card source and turn id', () => {
  const action = parseFeishuCardActionEvent({
    header: { event_type: 'card.action.trigger' },
    event: {
      context: {
        open_chat_id: 'oc_test_chat_3',
        open_message_id: 'om_assistant_receipt_1'
      },
      action: {
        value: {
          kind: 'query_current_task',
          cardSource: 'assistant_reply_receipt',
          turnId: 'turn-7'
        }
      }
    }
  });

  assert.deepEqual(action, {
    threadId: 'feishu:chat:oc_test_chat_3',
    messageId: 'om_assistant_receipt_1',
    kind: 'query_current_task',
    cardSource: 'assistant_reply_receipt',
    turnId: 'turn-7'
  });
});
