import {
  formatCommunicateTaskRuntimeConfig,
  listCommunicateRuntimeWarningMessages,
  type CommunicateRuntimeWarning,
  type CommunicateSessionKind,
  type CommunicateSessionStartupMode,
  type CommunicateTaskModel
} from '../protocol/task-types';

export type FeishuModeStatusCardInput = {
  mode?: 'status' | 'launcher' | 'launcher_with_error';
  displayMode: 'assistant' | 'coding';
  currentCodingTaskId?: string;
  currentTaskLifecycle?: string;
  currentTaskModel?: CommunicateTaskModel;
  currentTaskSandbox?: string | null;
  currentTaskApprovalPolicy?: string | null;
  currentTaskSessionKind?: CommunicateSessionKind | null;
  currentTaskStartupMode?: CommunicateSessionStartupMode | null;
  currentTaskInterruptedByRestart?: boolean | null;
  currentTaskDefaultSandbox?: string;
  currentTaskDefaultApprovalPolicy?: string;
  currentTaskRuntimeWarnings?: CommunicateRuntimeWarning[];
  pickerOpen?: boolean;
  pickerTasks?: Array<{
    taskId: string;
    lifecycle: string;
    goalSummary?: string;
    goalSummaryStatus?: 'pending' | 'ready' | 'failed';
    cwd?: string;
  }>;
  recentProjectDirs?: string[];
  launcherSelectedCwd?: string;
  launcherDraftCwd?: string;
  launcherError?: string;
};

type FeishuCardButtonValue =
  | {
      kind:
        | 'switch_mode_assistant'
        | 'switch_mode_coding'
        | 'open_task_picker'
        | 'create_new_task'
        | 'interrupt_stalled_task'
        | 'return_to_launcher'
        | 'close_current_task';
      cardSource?: 'reply_status_card' | 'approval_card';
    }
  | {
      kind: 'query_current_task';
      cardSource?: 'reply_status_card';
    }
  | {
      kind: 'query_current_task';
      cardSource: 'assistant_reply_receipt';
      turnId: string;
    }
  | { kind: 'pick_current_task'; taskId: `T${number}` }
  | { kind: 'select_recent_cwd'; cwd: string }
  | { kind: 'submit_launch_coding' }
  | {
      kind: 'allow_waiting_task' | 'deny_waiting_task';
      taskId: `T${number}`;
      cardSource: 'approval_card';
    };

type FeishuCardButtonType =
  | 'default'
  | 'primary'
  | 'danger'
  | 'success'
  | 'primary_filled'
  | 'danger_filled'
  | 'primary_text'
  | 'danger_text';

function buildCallbackButton(
  label: string,
  value: FeishuCardButtonValue,
  type: FeishuCardButtonType = 'default'
): Record<string, unknown> {
  return {
    tag: 'button',
    type,
    text: { tag: 'plain_text', content: label },
    behaviors: [{ type: 'callback', value }]
  };
}

function buildFormSubmitButton(
  label: string,
  name: string,
  type: FeishuCardButtonType = 'default'
): Record<string, unknown> {
  return {
    tag: 'button',
    name,
    action_type: 'form_submit',
    type,
    text: { tag: 'plain_text', content: label }
  };
}

function resolveMainActionButtonType(
  kind: Exclude<FeishuCardButtonValue['kind'], 'pick_current_task'>,
  displayMode: FeishuModeStatusCardInput['displayMode']
): 'default' | 'primary' | 'danger' {
  if (
    (kind === 'switch_mode_assistant' && displayMode !== 'assistant') ||
    (kind === 'switch_mode_coding' && displayMode !== 'coding') ||
    kind === 'open_task_picker' ||
    kind === 'create_new_task' ||
    kind === 'query_current_task' ||
    kind === 'return_to_launcher'
  ) {
    return 'primary';
  }
  if (kind === 'close_current_task') {
    return 'danger';
  }
  return 'default';
}

function buildButtonRow(buttons: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    tag: 'column_set',
    flex_mode: 'none',
    columns: buttons.map((button) => ({
      tag: 'column',
      width: 'weighted',
      weight: 1,
      vertical_align: 'top',
      elements: [button]
    }))
  };
}

function buildSingleButtonRow(button: Record<string, unknown>): Record<string, unknown> {
  return buildButtonRow([button]);
}

function buildPickerTaskGoalLine(
  task: NonNullable<FeishuModeStatusCardInput['pickerTasks']>[number]
): string {
  if (task.goalSummaryStatus === 'pending') {
    return '目标：摘要生成中...';
  }
  const summary = task.goalSummary?.trim();
  return summary ? `目标：${summary}` : '目标：暂无摘要';
}

function buildPickerTaskElements(tasks: NonNullable<FeishuModeStatusCardInput['pickerTasks']>): Array<Record<string, unknown>> {
  return tasks.flatMap((task) => {
    const detailLines = [
      `**${task.taskId} · ${task.lifecycle}**`,
      buildPickerTaskGoalLine(task),
      `路径：${task.cwd?.trim() || '未记录'}`
    ];
    return [
      { tag: 'markdown', content: detailLines.join('\n') },
      buildSingleButtonRow(
        buildCallbackButton(`切换到 ${task.taskId}`, { kind: 'pick_current_task', taskId: task.taskId as `T${number}` }, 'primary')
      )
    ];
  });
}

type FeishuRuntimeConfigInput = {
  model?: CommunicateTaskModel;
  sandbox?: string | null;
  approvalPolicy?: string | null;
  sessionKind?: CommunicateSessionKind | null;
  startupMode?: CommunicateSessionStartupMode | null;
  interruptedByRestart?: boolean | null;
  defaultSandbox?: string;
  defaultApprovalPolicy?: string;
};

function buildRuntimeConfigLines(input: FeishuRuntimeConfigInput): string[] {
  const hasConfig = [
    input.model,
    input.sandbox,
    input.approvalPolicy,
    input.sessionKind,
    input.startupMode,
    input.interruptedByRestart,
    input.defaultSandbox,
    input.defaultApprovalPolicy
  ].some((value) => value !== undefined);
  if (!hasConfig) return [];
  const config = formatCommunicateTaskRuntimeConfig(input);
  return [`配置：${config.primary}`];
}

export type FeishuReplyStatusCardState = 'running' | 'suspected_stalled' | 'interrupting' | 'completed' | 'interrupted';
export type FeishuApprovalCardState = 'pending' | 'allowed' | 'denied' | 'unavailable';

function buildReplyStatusCardAppearance(status: FeishuReplyStatusCardState): {
  title: string;
  template: 'green' | 'blue' | 'red';
  buttonType: 'default' | 'primary' | 'danger';
} {
  if (status === 'running') {
    return {
      title: '运行中',
      template: 'green',
      buttonType: 'primary'
    };
  }
  if (status === 'suspected_stalled') {
    return {
      title: '疑似卡死',
      template: 'red',
      buttonType: 'default'
    };
  }
  if (status === 'interrupting') {
    return {
      title: '打断中',
      template: 'blue',
      buttonType: 'default'
    };
  }
  if (status === 'interrupted') {
    return {
      title: '已中断',
      template: 'red',
      buttonType: 'danger'
    };
  }
  return {
    title: '已完成',
    template: 'blue',
    buttonType: 'default'
  };
}

function buildProgressCard(
  appearance: ReturnType<typeof buildReplyStatusCardAppearance>,
  input: {
    displayTitle?: string;
    phaseLabel?: string;
    activityLabel?: string;
    updatedLabel?: string;
    detailLines?: string[];
    actionRows: Array<Record<string, unknown>>;
  }
): Record<string, unknown> {
  const detailElements: Array<Record<string, unknown>> = [];
  if (input.phaseLabel?.trim()) {
    detailElements.push({ tag: 'markdown', content: `当前阶段：${input.phaseLabel.trim()}` });
  }
  if (input.activityLabel?.trim()) {
    detailElements.push({ tag: 'markdown', content: `最近动作：${input.activityLabel.trim()}` });
  }
  if (input.updatedLabel?.trim()) {
    detailElements.push({ tag: 'markdown', content: `最近更新：${input.updatedLabel.trim()}` });
  }
  for (const detailLine of input.detailLines ?? []) {
    const trimmed = detailLine.trim();
    if (!trimmed) continue;
    detailElements.push({ tag: 'markdown', content: trimmed });
  }
  return {
    schema: '2.0',
    config: { wide_screen_mode: false },
    header: {
      template: appearance.template,
      title: { tag: 'plain_text', content: input.displayTitle?.trim() || appearance.title }
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 12px 12px',
      elements: [...detailElements, ...input.actionRows]
    }
  };
}

export function renderFeishuReplyStatusCard(input: {
  taskId: string;
  status: FeishuReplyStatusCardState;
  displayTitle?: string;
  phaseLabel?: string;
  activityLabel?: string;
  updatedLabel?: string;
  allowInterrupt?: boolean;
  model?: CommunicateTaskModel;
  sandbox?: string | null;
  approvalPolicy?: string | null;
  sessionKind?: CommunicateSessionKind | null;
  startupMode?: CommunicateSessionStartupMode | null;
  interruptedByRestart?: boolean | null;
  defaultSandbox?: string;
  defaultApprovalPolicy?: string;
}): Record<string, unknown> {
  const appearance = buildReplyStatusCardAppearance(input.status);
  const actionRows = [
    buildSingleButtonRow(
      buildCallbackButton(
        '查询任务进展',
        { kind: 'query_current_task', cardSource: 'reply_status_card' },
        appearance.buttonType
      )
    )
  ];
  if (input.allowInterrupt ?? input.status === 'suspected_stalled') {
    actionRows.push(
      buildSingleButtonRow(
        buildCallbackButton(
          '打断当前任务',
          { kind: 'interrupt_stalled_task', cardSource: 'reply_status_card' },
          'danger'
        )
        )
      );
  }
  return buildProgressCard(appearance, {
    displayTitle: input.displayTitle,
    phaseLabel: input.phaseLabel,
    activityLabel: input.activityLabel,
    updatedLabel: input.updatedLabel,
    detailLines: buildRuntimeConfigLines(input),
    actionRows
  });
}

export function renderFeishuAssistantReplyReceiptCard(input: {
  status: FeishuReplyStatusCardState;
  displayTitle?: string;
  phaseLabel?: string;
  activityLabel?: string;
  updatedLabel?: string;
  turnId?: string;
  model?: CommunicateTaskModel;
  sandbox?: string | null;
  approvalPolicy?: string | null;
  sessionKind?: CommunicateSessionKind | null;
  startupMode?: CommunicateSessionStartupMode | null;
  interruptedByRestart?: boolean | null;
  defaultSandbox?: string;
  defaultApprovalPolicy?: string;
}): Record<string, unknown> {
  const appearance = buildReplyStatusCardAppearance(input.status);
  const actionRows =
    typeof input.turnId === 'string' && input.turnId.trim()
      ? [
          buildSingleButtonRow(
            buildCallbackButton(
              '查询当前状态',
              {
                kind: 'query_current_task',
                cardSource: 'assistant_reply_receipt',
                turnId: input.turnId.trim()
              },
              appearance.buttonType
            )
          )
        ]
      : [];
  return buildProgressCard(appearance, {
    displayTitle: input.displayTitle,
    phaseLabel: input.phaseLabel,
    activityLabel: input.activityLabel,
    updatedLabel: input.updatedLabel,
    detailLines: buildRuntimeConfigLines(input),
    actionRows
  });
}

function buildApprovalCardAppearance(state: FeishuApprovalCardState, taskId: string): {
  title: string;
  template: 'green' | 'blue' | 'red';
  note?: string;
} {
  if (state === 'allowed') {
    return {
      title: `任务 ${taskId} 已允许`,
      template: 'green',
      note: '已提交允许指令。'
    };
  }
  if (state === 'denied') {
    return {
      title: `任务 ${taskId} 已拒绝`,
      template: 'red',
      note: '已提交拒绝指令。'
    };
  }
  if (state === 'unavailable') {
    return {
      title: `任务 ${taskId} 审批已失效`,
      template: 'red',
      note: '该审批已失效，请以最新提示为准。'
    };
  }
  return {
    title: `任务 ${taskId} 等待审批`,
    template: 'blue'
  };
}

export function renderFeishuApprovalCard(input: {
  taskId: string;
  state: FeishuApprovalCardState;
  kind?: 'command' | 'file_change';
  reason?: string;
  cwd?: string;
  detailLabel?: string;
  detailValue?: string;
  previewLines: string[];
  content?: string;
  command: string;
}): Record<string, unknown> {
  const appearance = buildApprovalCardAppearance(input.state, input.taskId);
  const kind = input.kind ?? 'command';
  const detailLabel = input.detailLabel?.trim() || (kind === 'file_change' ? '范围' : '目录');
  const detailValue = (input.detailValue ?? input.cwd)?.trim();
  const previewLabel = kind === 'file_change' ? '审批内容' : '命令预览';
  const collapsibleTitle = kind === 'file_change' ? '展开查看完整审批内容' : '展开查看完整命令';
  const fullContent = (input.content ?? input.command).trim();
  const preview = input.previewLines.filter((line) => line.trim() !== '').join('\n');
  const elements: Array<Record<string, unknown>> = [
    { tag: 'markdown', content: `**需要你的审批**` }
  ];
  if (input.reason?.trim()) {
    elements.push({ tag: 'markdown', content: `原因：${input.reason.trim()}` });
  }
  if (detailValue) {
    elements.push({ tag: 'markdown', content: `${detailLabel}：${detailValue}` });
  }
  if (preview) {
    elements.push({ tag: 'markdown', content: `${previewLabel}：\n\`\`\`text\n${preview}\n\`\`\`` });
  }
  elements.push({
    tag: 'collapsible_panel',
    header: {
      title: { tag: 'plain_text', content: collapsibleTitle }
    },
    direction: 'vertical',
    padding: '8px 0px 8px 0px',
    elements: [{ tag: 'markdown', content: `\`\`\`text\n${fullContent}\n\`\`\`` }]
  });
  if (appearance.note) {
    elements.push({ tag: 'markdown', content: appearance.note });
  }
  if (input.state === 'pending') {
    elements.push(
      buildButtonRow([
        buildCallbackButton('允许', { kind: 'allow_waiting_task', taskId: input.taskId as `T${number}`, cardSource: 'approval_card' }, 'primary'),
        buildCallbackButton('拒绝', { kind: 'deny_waiting_task', taskId: input.taskId as `T${number}`, cardSource: 'approval_card' }, 'danger')
      ])
    );
  }
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      template: appearance.template,
      title: { tag: 'plain_text', content: appearance.title }
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 12px 12px',
      elements
    }
  };
}

function buildLauncherElements(input: FeishuModeStatusCardInput): Array<Record<string, unknown>> {
  const selectedOrDraft = input.launcherDraftCwd ?? input.launcherSelectedCwd ?? '';
  const recentProjectDirs = input.recentProjectDirs ?? [];
  const recentElements =
    recentProjectDirs.length === 0
      ? [{ tag: 'markdown', content: '暂无最近项目目录。' }]
      : recentProjectDirs.flatMap((cwd) => [
          {
            tag: 'markdown',
            content: cwd === input.launcherSelectedCwd ? `**已选最近目录：${cwd}**` : `最近目录：${cwd}`
          },
          buildSingleButtonRow(
            buildCallbackButton(
              `使用 ${cwd}`,
              { kind: 'select_recent_cwd', cwd },
              cwd === input.launcherSelectedCwd ? 'primary' : 'default'
            )
          )
        ]);

  return [
    { tag: 'markdown', content: '**启动 Codex 编程窗口**' },
    {
      tag: 'markdown',
      content: input.mode === 'launcher_with_error' && input.launcherError
        ? `**错误：${input.launcherError}**`
        : '请选择最近目录，或直接输入新的 Windows 项目路径。'
    },
    { tag: 'markdown', content: `当前候选目录：${selectedOrDraft || '未选择'}` },
    ...recentElements,
    {
      tag: 'form',
      name: 'launch_coding_form',
      elements: [
        {
          tag: 'input',
          name: 'project_cwd',
          label: { tag: 'plain_text', content: '项目目录' },
          placeholder: { tag: 'plain_text', content: '例如 D:\\Workspace\\Project' },
          default_value: selectedOrDraft
        },
        buildFormSubmitButton('启动编程窗口', 'submit_launch_coding', 'primary')
      ]
    }
  ];
}

export function renderFeishuModeStatusCard(input: FeishuModeStatusCardInput): Record<string, unknown> {
  const mode = input.mode ?? 'status';
  if (mode === 'launcher' || mode === 'launcher_with_error') {
    return {
      schema: '2.0',
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: 'Codex 启动入口' }
      },
      body: {
        direction: 'vertical',
        padding: '12px 12px 12px 12px',
        elements: buildLauncherElements(input)
      }
    };
  }

  const modeText = input.displayMode === 'coding' ? 'Coding' : '普通助手';
  const routeText =
    input.displayMode === 'coding' && input.currentCodingTaskId ? input.currentCodingTaskId : '助手';

  const actionButtons = [
    buildCallbackButton(
      input.displayMode === 'assistant' ? '当前: 普通助手' : '切到普通助手',
      { kind: 'switch_mode_assistant' },
      resolveMainActionButtonType('switch_mode_assistant', input.displayMode)
    ),
    buildCallbackButton(
      input.displayMode === 'coding' ? '当前: Coding' : '切到 Coding',
      { kind: 'switch_mode_coding' },
      resolveMainActionButtonType('switch_mode_coding', input.displayMode)
    ),
    buildCallbackButton(
      '切换当前任务',
      { kind: 'open_task_picker' },
      resolveMainActionButtonType('open_task_picker', input.displayMode)
    ),
    buildCallbackButton(
      '新建任务',
      { kind: 'create_new_task' },
      resolveMainActionButtonType('create_new_task', input.displayMode)
    ),
      buildCallbackButton(
        '查询任务进展',
        { kind: 'query_current_task' },
        resolveMainActionButtonType('query_current_task', input.displayMode)
      ),
    buildCallbackButton(
      '返回启动卡',
      { kind: 'return_to_launcher' },
      resolveMainActionButtonType('return_to_launcher', input.displayMode)
    ),
    buildCallbackButton(
      '关闭当前任务',
      { kind: 'close_current_task' },
      resolveMainActionButtonType('close_current_task', input.displayMode)
    )
  ];

  const actionRows = input.pickerOpen
    ? buildPickerTaskElements(input.pickerTasks ?? [])
    : actionButtons.map((button) => buildSingleButtonRow(button));

  const emptyPickerHint =
    input.pickerOpen && (input.pickerTasks ?? []).length === 0
      ? [{ tag: 'markdown', content: '当前没有可切换的 Coding 任务。' }]
      : [];
  const runtimeConfigLines = buildRuntimeConfigLines({
    model: input.currentTaskModel,
    sandbox: input.currentTaskSandbox,
    approvalPolicy: input.currentTaskApprovalPolicy,
    sessionKind: input.currentTaskSessionKind,
    startupMode: input.currentTaskStartupMode,
    interruptedByRestart: input.currentTaskInterruptedByRestart,
    defaultSandbox: input.currentTaskDefaultSandbox,
    defaultApprovalPolicy: input.currentTaskDefaultApprovalPolicy
  }).map((line) => ({ tag: 'markdown', content: line }));
  const runtimeWarningLines = listCommunicateRuntimeWarningMessages(input.currentTaskRuntimeWarnings)
    .map((message) => ({ tag: 'markdown', content: message }));

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: 'Codex 模式状态' }
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 12px 12px',
      elements: [
        { tag: 'markdown', content: `**当前模式：${modeText}**` },
        { tag: 'markdown', content: `当前 Coding 目标：${input.currentCodingTaskId ?? '未绑定'}` },
        { tag: 'markdown', content: `普通消息默认去向：${routeText}` },
        { tag: 'markdown', content: `任务状态：${input.currentTaskLifecycle ?? 'N/A'}` },
        ...runtimeWarningLines,
        ...runtimeConfigLines,
        {
          tag: 'markdown',
          content: input.pickerOpen ? '请选择新的 Coding 目标：' : '点击按钮可直接切换模式；回复前缀仍可作为兜底。'
        },
        ...emptyPickerHint,
        ...actionRows
      ]
    }
  };
}
