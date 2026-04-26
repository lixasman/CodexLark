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

test('parseFeishuCardActionEvent recognizes open_takeover_picker', () => {
  const action = parseFeishuCardActionEvent({
    header: { event_type: 'card.action.trigger' },
    event: {
      context: {
        open_chat_id: 'oc_test_chat_4',
        open_message_id: 'om_takeover_1'
      },
      action: {
        value: {
          kind: 'open_takeover_picker'
        }
      }
    }
  });

  assert.deepEqual(action, {
    threadId: 'feishu:chat:oc_test_chat_4',
    messageId: 'om_takeover_1',
    kind: 'open_takeover_picker'
  });
});

test('parseFeishuCardActionEvent recognizes pick_takeover_task with task id', () => {
  const action = parseFeishuCardActionEvent({
    header: { event_type: 'card.action.trigger' },
    event: {
      context: {
        open_chat_id: 'oc_test_chat_5',
        open_message_id: 'om_takeover_2'
      },
      action: {
        value: {
          kind: 'pick_takeover_task',
          taskId: 'T42'
        }
      }
    }
  });

  assert.deepEqual(action, {
    threadId: 'feishu:chat:oc_test_chat_5',
    messageId: 'om_takeover_2',
    kind: 'pick_takeover_task',
    taskId: 'T42'
  });
});

test('parseFeishuCardActionEvent recognizes return_to_status', () => {
  const action = parseFeishuCardActionEvent({
    header: { event_type: 'card.action.trigger' },
    event: {
      context: {
        open_chat_id: 'oc_test_chat_6',
        open_message_id: 'om_takeover_3'
      },
      action: {
        value: JSON.stringify({
          kind: 'return_to_status'
        })
      }
    }
  });

  assert.deepEqual(action, {
    threadId: 'feishu:chat:oc_test_chat_6',
    messageId: 'om_takeover_3',
    kind: 'return_to_status'
  });
});

test('parseFeishuCardActionEvent rejects pick_takeover_task with invalid task id', () => {
  const action = parseFeishuCardActionEvent({
    header: { event_type: 'card.action.trigger' },
    event: {
      context: {
        open_chat_id: 'oc_test_chat_7',
        open_message_id: 'om_takeover_4'
      },
      action: {
        value: {
          kind: 'pick_takeover_task',
          taskId: 'bad-id'
        }
      }
    }
  });

  assert.equal(action, null);
});

test('parseFeishuCardActionEvent preserves JSON string callback payload for takeover actions', () => {
  const action = parseFeishuCardActionEvent({
    header: { event_type: 'card.action.trigger' },
    event: {
      context: {
        chat_id: 'oc_test_chat_8',
        message_id: 'om_takeover_5'
      },
      action: {
        value: JSON.stringify({
          kind: 'pick_takeover_task',
          taskId: 'T77'
        })
      }
    }
  });

  assert.deepEqual(action, {
    threadId: 'feishu:chat:oc_test_chat_8',
    messageId: 'om_takeover_5',
    kind: 'pick_takeover_task',
    taskId: 'T77'
  });
});
