import {
  formatCommunicateTaskRuntimeConfig,
  listCommunicateRuntimeWarningMessages,
  type CommunicateRuntimeWarning
} from '../protocol/task-types';

export function formatCheckpointDelivery(input: {
  taskId: string;
  lifecycle: string;
  output: string;
  waitHint?: string;
  runtimeWarnings?: CommunicateRuntimeWarning[];
}): string {
  const lines = [`任务 ${input.taskId}`, `状态 ${input.lifecycle}`];
  lines.push(...listCommunicateRuntimeWarningMessages(input.runtimeWarnings));
  lines.push('', input.output.trim());
  if (input.waitHint) {
    lines.push('', `可回复：${input.waitHint}`);
  }
  return lines.join('\n');
}

export function formatStatusQueryDelivery(input: {
  taskId: string;
  lifecycle: string;
  model?: string | null;
  sandbox?: string | null;
  approvalPolicy?: string | null;
  sessionKind?: 'coding' | 'assistant' | null;
  startupMode?: 'new' | 'resume' | null;
  interruptedByRestart?: boolean | null;
  defaultSandbox?: string;
  defaultApprovalPolicy?: string;
  quietMinutes: number;
  recentSummary: string;
  waitHint?: string;
  logFilePath?: string;
  screenshotPath?: string;
  codexThreadId?: string;
  recoveryNote?: string;
  runtimeWarnings?: CommunicateRuntimeWarning[];
}): string {
  const config = formatCommunicateTaskRuntimeConfig({
    model: input.model,
    sandbox: input.sandbox,
    approvalPolicy: input.approvalPolicy,
    sessionKind: input.sessionKind,
    startupMode: input.startupMode,
    interruptedByRestart: input.interruptedByRestart,
    defaultSandbox: input.defaultSandbox,
    defaultApprovalPolicy: input.defaultApprovalPolicy
  });
  const lines = [
    `任务 ${input.taskId}`,
    `状态 ${input.lifecycle}`,
    ...listCommunicateRuntimeWarningMessages(input.runtimeWarnings),
    `配置 ${config.primary}`,
    `静默时长 ${input.quietMinutes} 分钟`,
    `最近摘要 ${input.recentSummary}`
  ];
  if (config.showSecondary) {
    lines.splice(3, 0, `会话 ${config.secondary}`);
  }
  if (input.waitHint) {
    lines.push(`可回复 ${input.waitHint}`);
  }
  if (input.recoveryNote) {
    lines.push(`恢复提示 ${input.recoveryNote}`);
  }
  if (input.logFilePath) {
    lines.push(`日志 ${input.logFilePath}`);
  }
  if (input.codexThreadId) {
    lines.push(`Codex Thread ${input.codexThreadId}`);
    lines.push(`Official Resume codex resume ${input.codexThreadId}`);
  }
  if (input.screenshotPath) {
    lines.push(`截图 ${input.screenshotPath}`);
  }
  return lines.join('\n');
}

export function formatTaskProgressDelivery(input: {
  taskId: string;
  lifecycle: string;
  previousOutput?: string;
  liveOutput?: string;
  waitHint?: string;
}): string {
  return input.previousOutput?.trim() || '暂无上一轮 Codex 回复。';
}

export function formatPolishCandidateDelivery(input: { taskId: string; candidateText: string }): string {
  return [
    `任务 ${input.taskId} 润色候选`,
    '',
    input.candidateText.trim(),
    '',
    `如需发送，请回复：对 ${input.taskId} 确认发送`
  ].join('\n');
}

export function formatTakeoverList(tasks: Array<{
  id: string;
  origin?: string;
  lifecycle: string;
  model?: string | null;
  sandbox?: string | null;
  approvalPolicy?: string | null;
  sessionKind?: 'coding' | 'assistant' | null;
  startupMode?: 'new' | 'resume' | null;
  interruptedByRestart?: boolean | null;
  defaultSandbox?: string;
  defaultApprovalPolicy?: string;
  codexThreadId?: string;
  cwd?: string;
  summary?: string;
}>): string {
  if (tasks.length === 0) return '未发现可接管的 CLI 会话。';
  return tasks
    .map((task) => {
      const config = formatCommunicateTaskRuntimeConfig({
        model: task.model,
        sandbox: task.sandbox,
        approvalPolicy: task.approvalPolicy,
        sessionKind: task.sessionKind,
        startupMode: task.startupMode,
        interruptedByRestart: task.interruptedByRestart,
        defaultSandbox: task.defaultSandbox,
        defaultApprovalPolicy: task.defaultApprovalPolicy
      });
      const lines = [
        '任务 ' + task.id,
        '来源 ' + (task.origin ?? 'unknown'),
        '状态 ' + task.lifecycle,
        '配置 ' + config.primary,
        'threadId ' + (task.codexThreadId ?? 'unknown'),
        'cwd ' + (task.cwd ?? 'unknown'),
        '最近摘要 ' + (task.summary ?? '暂无输出')
      ];
      if (config.showSecondary) {
        lines.splice(4, 0, '会话 ' + config.secondary);
      }
      return lines.join('\n');
    })
    .join('\n\n');
}
