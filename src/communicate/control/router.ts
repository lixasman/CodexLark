import { isCommunicateTaskId } from '../protocol/task-types';
import { type StructuredTaskCommand, type RouteUserMessageInput } from './router-types';

const CHINESE_DIGITS: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10
};

function baseCommand(input: RouteUserMessageInput, reason: string): Omit<StructuredTaskCommand, 'intent' | 'params'> {
  return {
    targetThreadId: input.threadId,
    confidence: 0.9,
    needsClarification: false,
    reason
  };
}



function parseChoiceIndex(value: string): number | null {
  const normalized = value.trim();
  if (/^\d+$/.test(normalized)) return Number(normalized);
  return CHINESE_DIGITS[normalized] ?? null;
}

function routeExplicitTaskReply(input: RouteUserMessageInput, taskId: string, remainder: string): StructuredTaskCommand {
  const common = baseCommand(input, 'explicit_task_reply');
  const trimmed = remainder.trim();
  const choiceMatch = trimmed.match(/^选择第\s*([一二三四五六七八九十\d]+)\s*个$/);
  if (choiceMatch) {
    const index = parseChoiceIndex(choiceMatch[1] ?? '');
    return {
      ...common,
      intent: 'reply_task',
      taskId,
      params: index ? { action: 'choose_index', index } : { action: 'choose_index' },
      needsClarification: index == null,
      clarificationPrompt: index == null ? `无法识别 ${taskId} 的选项序号，请明确写出第几个。` : undefined
    };
  }

  const inputMatch = trimmed.match(/^输入[:：]\s*(.+)$/s);
  if (inputMatch) {
    return {
      ...common,
      intent: 'reply_task',
      taskId,
      params: { action: 'input_text', text: inputMatch[1]?.trim() ?? '' }
    };
  }

  const polishMatch = trimmed.match(/^请帮我润色我的话语后发送给\s*codex[:：]\s*(.+)$/is);
  if (polishMatch) {
    return {
      ...common,
      intent: 'reply_task',
      taskId,
      params: { action: 'polish_then_confirm', text: polishMatch[1]?.trim() ?? '' },
      reason: 'explicit_polish_then_confirm'
    };
  }

  if (/^(确认发送|发送润色稿|确认发送润色稿)$/.test(trimmed)) {
    return {
      ...common,
      intent: 'reply_task',
      taskId,
      params: { action: 'confirm_polish_send' },
      reason: 'explicit_confirm_polish_send'
    };
  }

  if (/^(允许|同意|确认)$/.test(trimmed)) {
    return {
      ...common,
      intent: 'reply_task',
      taskId,
      params: { action: 'confirm', value: 'allow' }
    };
  }

  if (/^(拒绝|不允许|取消)$/.test(trimmed)) {
    return {
      ...common,
      intent: 'reply_task',
      taskId,
      params: { action: 'confirm', value: 'deny' }
    };
  }

  return {
    ...common,
    intent: 'reply_task',
    taskId,
    params: { action: 'free_text', text: trimmed }
  };
}

export function routeUserMessage(input: RouteUserMessageInput): StructuredTaskCommand {
  const text = input.text.trim();

  const takeoverTaskMatch = text.match(/^接管\s*(T\d+)\s*[。，,；：:]*$/i);
  if (takeoverTaskMatch && isCommunicateTaskId(takeoverTaskMatch[1] ?? '')) {
    return {
      ...baseCommand(input, 'takeover_local_codex'),
      intent: 'takeover_local_codex',
      taskId: takeoverTaskMatch[1],
      params: {}
    };
  }

  if (isExplicitTakeoverCommand(text)) {
    return {
      ...baseCommand(input, 'takeover_local_codex'),
      intent: 'takeover_local_codex',
      params: {}
    };
  }


  const queryStatusMatch = text.match(/^查询\s*(T\d+)\s*状态$/i);
  if (queryStatusMatch && isCommunicateTaskId(queryStatusMatch[1] ?? '')) {
    return {
      ...baseCommand(input, 'query_task_status'),
      intent: 'query_task',
      taskId: queryStatusMatch[1],
      params: { view: 'status' }
    };
  }

  const queryProgressMatch = text.match(/^查询\s*(T\d+)\s*进展$/i);
  if (queryProgressMatch && isCommunicateTaskId(queryProgressMatch[1] ?? '')) {
    return {
      ...baseCommand(input, 'query_task_progress'),
      intent: 'query_task',
      taskId: queryProgressMatch[1],
      params: { view: 'progress' }
    };
  }

  const closeMatch = text.match(/^关闭\s*(T\d+)\s*[。！!，,；;：:]*$/i);
  if (closeMatch && isCommunicateTaskId(closeMatch[1] ?? '')) {
    return {
      ...baseCommand(input, 'cancel_codex_session'),
      intent: 'cancel_task',
      taskId: closeMatch[1],
      params: {}
    };
  }

  const resumeMatch = text.match(/^(恢复|重新打开|重开)\s*(T\d+)\s*[。，,；：:]*$/i);
  if (resumeMatch && isCommunicateTaskId(resumeMatch[2] ?? '')) {
    return {
      ...baseCommand(input, 'resume_codex_session'),
      intent: 'resume_task',
      taskId: resumeMatch[2],
      params: {}
    };
  }
  const explicitReplyMatch = text.match(/^对\s*(T\d+)\s*(.+)$/is);
  if (explicitReplyMatch && isCommunicateTaskId(explicitReplyMatch[1] ?? '')) {
    return routeExplicitTaskReply(input, explicitReplyMatch[1], explicitReplyMatch[2] ?? '');
  }

  if (shouldStartCodexSession(text)) {
    const cwd = extractAsciiWindowsPath(text);
    return {
      ...baseCommand(input, cwd ? 'start_codex_session' : 'start_codex_session_missing_cwd'),
      intent: 'start_task',
      taskType: 'codex_session',
      params: cwd ? { cwd } : {},
      needsClarification: !cwd,
      clarificationPrompt: cwd ? undefined : '请告诉我要在哪个目录下启动 Codex，例如：帮我在 D:\\Workspace\\Project 下开一个 codex 窗口。'
    };
  }

  return {
    ...baseCommand(input, 'default_chat_reply'),
    intent: 'start_task',
    taskType: 'chat_reply',
    params: { message: text },
    confidence: 0.6
  };
}

function extractAsciiWindowsPath(text: string): string | undefined {
  const matched = text.match(/([A-Za-z]:\\[A-Za-z0-9_ .()\\/-]+)/);
  const normalized = matched?.[1]?.trim().replace(/[。！!，,；;：:]+$/u, '');
  return normalized && /^[A-Za-z]:\\/.test(normalized) ? normalized : undefined;
}

function isExplicitTakeoverCommand(text: string): boolean {
  return /^接管(?:本地)?\s*codex(?:\s*(?:会话|窗口|任务|项目))?\s*[。，,；：:]*$/i.test(text.trim());
}

function shouldStartCodexSession(text: string): boolean {
  const normalized = text.trim();
  const explicitCodexStart =
    /(?:帮我|请|麻烦你|在.+)?(?:开|启动|打开).{0,20}codex/i.test(normalized) ||
    /codex.{0,20}(?:窗口|会话)/i.test(normalized);
  if (explicitCodexStart) return true;
  if (looksLikeCapabilityQuestion(normalized)) return false;

  const hasPath = Boolean(extractAsciiWindowsPath(normalized));
  if (hasPath && /(?:写代码|改代码|跑任务|执行任务|做开发|编码任务)/.test(normalized)) {
    return true;
  }

  return false;
}

function looksLikeCapabilityQuestion(text: string): boolean {
  if (/[？]/.test(text)) return true;
  return /(能否|能不能|可以|是否|会不会|能做到|做得到|办得到)/.test(text);
}














