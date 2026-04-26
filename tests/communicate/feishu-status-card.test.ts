import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderFeishuApprovalCard,
  renderFeishuAssistantReplyReceiptCard,
  renderFeishuModeStatusCard,
  renderFeishuReplyStatusCard
} from '../../src/communicate/channel/feishu-status-card';

function collectButtons(node: unknown): Array<Record<string, any>> {
  if (!node || typeof node !== 'object') return [];
  const record = node as Record<string, unknown>;
  const nested = Object.values(record).flatMap((value) => {
    if (Array.isArray(value)) return value.flatMap((item) => collectButtons(item));
    return collectButtons(value);
  });
  return record.tag === 'button' ? [record as Record<string, any>, ...nested] : nested;
}

function collectTextContents(node: unknown): string[] {
  if (!node || typeof node !== 'object') return [];
  const record = node as Record<string, unknown>;
  const nested = Object.values(record).flatMap((value) => {
    if (Array.isArray(value)) return value.flatMap((item) => collectTextContents(item));
    return collectTextContents(value);
  });
  if (typeof record.content === 'string') {
    return [record.content, ...nested];
  }
  return nested;
}

function collectNodesByTag(node: unknown, tag: string): Array<Record<string, unknown>> {
  if (!node || typeof node !== 'object') return [];
  const record = node as Record<string, unknown>;
  const nested = Object.values(record).flatMap((value) => {
    if (Array.isArray(value)) return value.flatMap((item) => collectNodesByTag(item, tag));
    return collectNodesByTag(value, tag);
  });
  return record.tag === tag ? [record, ...nested] : nested;
}

function collectActionBlocks(node: { elements?: Array<Record<string, unknown>> } | undefined): Array<Record<string, unknown>> {
  return (node?.elements ?? []).filter((element) => collectButtons(element).length > 0);
}

test('status card renders schema 2.0 callback buttons for mode switching', () => {
  const card = renderFeishuModeStatusCard({
    displayMode: 'coding',
    currentCodingTaskId: 'T1',
    currentTaskLifecycle: 'IDLE',
    currentTaskModel: 'gpt-5.4',
    currentTaskSandbox: 'danger-full-access',
    currentTaskApprovalPolicy: 'on-request',
    currentTaskSessionKind: 'coding',
    currentTaskStartupMode: 'new',
    currentTaskInterruptedByRestart: false
  }) as {
    schema?: string;
    body?: { elements?: Array<Record<string, unknown>> };
  };

  assert.equal(card.schema, '2.0');
  assert.ok(Array.isArray(card.body?.elements));

  const buttons = collectButtons(card.body);
  assert.ok(buttons.length >= 7);
  const actionBlocks = collectActionBlocks(card.body);
  assert.ok(actionBlocks.length >= 7);
  assert.ok(actionBlocks.every((block) => collectButtons(block).length === 1));

  const byLabel = new Map(
    buttons.map((button) => [String((button.text as Record<string, unknown>)?.content ?? ''), button])
  );

  assert.equal(buttons.some((button) => button.type === 'primary_filled'), false);
  assert.equal(byLabel.get('切到普通助手')?.type, 'primary');
  assert.equal(byLabel.get('当前: Coding')?.type, 'default');
  assert.equal(byLabel.get('切换当前任务')?.type, 'primary');
  assert.equal(byLabel.get('新建任务')?.type, 'primary');
  assert.equal(byLabel.get('查询任务进展')?.type, 'primary');
  assert.equal(byLabel.get('返回启动卡')?.type, 'primary');
  assert.equal(byLabel.get('关闭当前任务')?.type, 'danger');

  assert.deepEqual(byLabel.get('切到普通助手')?.behaviors, [
    { type: 'callback', value: { kind: 'switch_mode_assistant' } }
  ]);
  assert.deepEqual(byLabel.get('当前: Coding')?.behaviors, [
    { type: 'callback', value: { kind: 'switch_mode_coding' } }
  ]);
  assert.deepEqual(byLabel.get('切换当前任务')?.behaviors, [
    { type: 'callback', value: { kind: 'open_task_picker' } }
  ]);
  assert.deepEqual(byLabel.get('新建任务')?.behaviors, [
    { type: 'callback', value: { kind: 'create_new_task' } }
  ]);
  assert.deepEqual(byLabel.get('查询任务进展')?.behaviors, [
    { type: 'callback', value: { kind: 'query_current_task' } }
  ]);
  assert.deepEqual(byLabel.get('返回启动卡')?.behaviors, [
    { type: 'callback', value: { kind: 'return_to_launcher' } }
  ]);
  assert.deepEqual(byLabel.get('关闭当前任务')?.behaviors, [
    { type: 'callback', value: { kind: 'close_current_task' } }
  ]);
  assert.ok(collectTextContents(card.body).includes('配置：model gpt-5.4 · sandbox danger-full-access · approvalPolicy on-request'));
  assert.equal(collectTextContents(card.body).includes('会话：sessionKind coding · 恢复态 否 · 中断恢复 否'), false);
});

test('status card renders task picker buttons as callback actions', () => {
  const card = renderFeishuModeStatusCard({
    displayMode: 'assistant',
    currentCodingTaskId: 'T2',
    currentTaskLifecycle: 'RUNNING_TURN',
    pickerOpen: true,
    pickerTasks: [
      {
        taskId: 'T1',
        lifecycle: 'IDLE',
        goalSummary: '修复飞书任务切换卡摘要不可读问题',
        goalSummaryStatus: 'ready',
        cwd: 'D:\\Workspace\\Project'
      },
      {
        taskId: 'T2',
        lifecycle: 'RUNNING_TURN',
        goalSummaryStatus: 'pending',
        cwd: 'D:\\Workspace\\Alpha'
      },
      {
        taskId: 'T3',
        lifecycle: 'FAILED',
        cwd: '',
        summary: '这里是旧的最近输出，不应再显示'
      }
    ] as any
  }) as {
    schema?: string;
    body?: { elements?: Array<Record<string, unknown>> };
  };

  assert.equal(card.schema, '2.0');

  const buttons = collectButtons(card.body);
  const actionBlocks = collectActionBlocks(card.body);
  const textContents = collectTextContents(card.body);
  assert.equal(actionBlocks.length, 3);
  assert.ok(actionBlocks.every((block) => collectButtons(block).length === 1));
  assert.deepEqual(
    buttons.map((button) => ({
      text: String((button.text as Record<string, unknown>)?.content ?? ''),
      type: button.type,
      behaviors: button.behaviors
    })),
    [
      {
        text: '切换到 T1',
        type: 'primary',
        behaviors: [{ type: 'callback', value: { kind: 'pick_current_task', taskId: 'T1' } }]
      },
      {
        text: '切换到 T2',
        type: 'primary',
        behaviors: [{ type: 'callback', value: { kind: 'pick_current_task', taskId: 'T2' } }]
      },
      {
        text: '切换到 T3',
        type: 'primary',
        behaviors: [{ type: 'callback', value: { kind: 'pick_current_task', taskId: 'T3' } }]
      }
    ]
  );
  assert.ok(
    textContents.includes('**T1 · IDLE**\n目标：修复飞书任务切换卡摘要不可读问题\n路径：D:\\Workspace\\Project')
  );
  assert.ok(textContents.includes('**T2 · RUNNING_TURN**\n目标：摘要生成中...\n路径：D:\\Workspace\\Alpha'));
  assert.ok(textContents.includes('**T3 · FAILED**\n目标：暂无摘要\n路径：未记录'));
  assert.equal(textContents.some((content) => content.includes('这里是旧的最近输出')), false);
});

test('status card marks assistant mode via label instead of filled button style', () => {
  const card = renderFeishuModeStatusCard({
    displayMode: 'assistant',
    currentCodingTaskId: 'T2',
    currentTaskLifecycle: 'IDLE',
    currentTaskModel: null,
    currentTaskSessionKind: 'assistant',
    currentTaskStartupMode: 'resume',
    currentTaskInterruptedByRestart: true,
    currentTaskDefaultSandbox: 'workspace-write',
    currentTaskDefaultApprovalPolicy: 'on-request'
  }) as {
    schema?: string;
    body?: { elements?: Array<Record<string, unknown>> };
  };

  assert.equal(card.schema, '2.0');

  const buttons = collectButtons(card.body);
  const labels = buttons.map((button) => String((button.text as Record<string, unknown>)?.content ?? ''));
  assert.equal(buttons.some((button) => button.type === 'primary_filled'), false);
  const byLabel = new Map(
    buttons.map((button) => [String((button.text as Record<string, unknown>)?.content ?? ''), button])
  );
  assert.ok(labels.includes('当前: 普通助手'));
  assert.ok(labels.includes('切到 Coding'));
  assert.ok(collectTextContents(card.body).includes('配置：model 未知 · sandbox 默认(workspace-write) · approvalPolicy 默认(on-request)'));
  assert.equal(collectTextContents(card.body).includes('会话：sessionKind assistant · 恢复态 是 · 中断恢复 是'), false);
  assert.equal(byLabel.get('当前: 普通助手')?.type, 'default');
  assert.equal(byLabel.get('切到 Coding')?.type, 'primary');
  assert.equal(byLabel.get('切换当前任务')?.type, 'primary');
  assert.equal(byLabel.get('新建任务')?.type, 'primary');
  assert.equal(byLabel.get('查询任务进展')?.type, 'primary');
  assert.equal(byLabel.get('返回启动卡')?.type, 'primary');
  assert.equal(byLabel.get('关闭当前任务')?.type, 'danger');
});

test('status card hides redundant default assistant session summary', () => {
  const card = renderFeishuModeStatusCard({
    displayMode: 'assistant',
    currentCodingTaskId: 'T2',
    currentTaskLifecycle: 'IDLE',
    currentTaskModel: 'gpt-5.4',
    currentTaskSandbox: 'danger-full-access',
    currentTaskApprovalPolicy: 'on-request',
    currentTaskSessionKind: 'assistant',
    currentTaskStartupMode: 'new',
    currentTaskInterruptedByRestart: false
  }) as {
    schema?: string;
    body?: { elements?: Array<Record<string, unknown>> };
  };

  assert.equal(card.schema, '2.0');

  const textContents = collectTextContents(card.body);
  assert.ok(textContents.includes('配置：model gpt-5.4 · sandbox danger-full-access · approvalPolicy on-request'));
  assert.equal(textContents.includes('会话：sessionKind assistant · 恢复态 否 · 中断恢复 否'), false);
});

test('status card renders runtime warning lines for known bad Codex override runs', () => {
  const card = renderFeishuModeStatusCard({
    displayMode: 'coding',
    currentCodingTaskId: 'T2',
    currentTaskLifecycle: 'IDLE',
    currentTaskRuntimeWarnings: [
      {
        code: 'known_bad_codex_version',
        message: '当前Codex版本存在不兼容问题，请尽快升级到最新版本',
        version: '0.120.0',
        overrideActive: true
      }
    ]
  }) as {
    schema?: string;
    body?: { elements?: Array<Record<string, unknown>> };
  };

  const textContents = collectTextContents(card.body);
  assert.ok(textContents.includes('当前Codex版本存在不兼容问题，请尽快升级到最新版本'));
  assert.ok(textContents.includes('任务状态：IDLE'));
});

test('reply status card marks its callback source explicitly', () => {
  const card = renderFeishuReplyStatusCard(({
    taskId: 'T1',
    status: 'running',
    displayTitle: 'T1 · 执行中',
    phaseLabel: '执行中',
    activityLabel: '正在推进当前任务',
    updatedLabel: '10 秒前',
    model: 'gpt-5.4',
    sandbox: 'danger-full-access',
    approvalPolicy: 'on-request',
    sessionKind: 'coding',
    startupMode: 'new',
    interruptedByRestart: false
  } as any)) as {
    header?: { title?: { content?: string } };
    body?: { elements?: Array<Record<string, unknown>> };
  };

  assert.equal(card.header?.title?.content, 'T1 · 执行中');

  const textContents = collectTextContents(card.body);
  assert.ok(textContents.includes('当前阶段：执行中'));
  assert.ok(textContents.includes('最近动作：正在推进当前任务'));
  assert.ok(textContents.includes('最近更新：10 秒前'));
  assert.ok(textContents.includes('配置：model gpt-5.4 · sandbox danger-full-access · approvalPolicy on-request'));
  assert.equal(textContents.includes('会话：sessionKind coding · 恢复态 否 · 中断恢复 否'), false);

  const buttons = collectButtons(card.body);
  assert.equal(buttons.length, 1);
  assert.deepEqual(buttons[0]?.behaviors, [{ type: 'callback', value: { kind: 'query_current_task', cardSource: 'reply_status_card' } }]);
});

test('reply status card exposes a manual interrupt action when command execution looks stalled', () => {
  const card = renderFeishuReplyStatusCard(({
    taskId: 'T1',
    status: 'suspected_stalled',
    displayTitle: 'T1 · 暂时无新进展',
    phaseLabel: '暂时无新进展',
    activityLabel: '正在验证修改',
    updatedLabel: '2 分钟前'
  } as any)) as {
    header?: { title?: { content?: string } };
    body?: { elements?: Array<Record<string, unknown>> };
  };

  assert.equal(card.header?.title?.content, 'T1 · 暂时无新进展');

  const textContents = collectTextContents(card.body);
  assert.ok(textContents.includes('当前阶段：暂时无新进展'));
  assert.ok(textContents.includes('最近动作：正在验证修改'));
  assert.ok(textContents.includes('最近更新：2 分钟前'));

  const buttons = collectButtons(card.body);
  assert.deepEqual(buttons.map((button) => ({
    text: String((button.text as Record<string, unknown>)?.content ?? ''),
    type: button.type,
    behaviors: button.behaviors
  })), [
    {
      text: '查询任务进展',
      type: 'default',
      behaviors: [{ type: 'callback', value: { kind: 'query_current_task', cardSource: 'reply_status_card' } }]
    },
    {
      text: '打断当前任务',
      type: 'danger',
      behaviors: [{ type: 'callback', value: { kind: 'interrupt_stalled_task', cardSource: 'reply_status_card' } }]
    }
  ]);
});

test('reply status card can render waiting-for-confirm progress copy without exposing interrupt controls', () => {
  const card = renderFeishuReplyStatusCard(({
    taskId: 'T1',
    status: 'running',
    displayTitle: 'T1 · 等待你确认',
    phaseLabel: '等待你确认',
    activityLabel: 'Codex 请求执行一项需要你确认的操作',
    updatedLabel: '40 秒前'
  } as any)) as {
    header?: { title?: { content?: string } };
    body?: { elements?: Array<Record<string, unknown>> };
  };

  assert.equal(card.header?.title?.content, 'T1 · 等待你确认');

  const textContents = collectTextContents(card.body);
  assert.ok(textContents.includes('当前阶段：等待你确认'));
  assert.ok(textContents.includes('最近动作：Codex 请求执行一项需要你确认的操作'));
  assert.ok(textContents.includes('最近更新：40 秒前'));

  const buttonLabels = collectButtons(card.body).map((button) => String((button.text as Record<string, unknown>)?.content ?? ''));
  assert.deepEqual(buttonLabels, ['查询任务进展']);
});

test('assistant reply receipt renders assistant title and only exposes query callback with turn id', () => {
  const card = renderFeishuAssistantReplyReceiptCard({
    status: 'running',
    displayTitle: '助手 · 分析中',
    phaseLabel: '分析中',
    activityLabel: '正在查看项目文件',
    updatedLabel: '刚刚',
    turnId: 'turn-7',
    model: 'gpt-5.4',
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
    sessionKind: 'assistant',
    startupMode: 'resume',
    interruptedByRestart: true
  }) as {
    header?: { title?: { content?: string } };
    body?: { elements?: Array<Record<string, unknown>> };
  };

  assert.equal(card.header?.title?.content, '助手 · 分析中');

  const textContents = collectTextContents(card.body);
  assert.ok(textContents.includes('当前阶段：分析中'));
  assert.ok(textContents.includes('最近动作：正在查看项目文件'));
  assert.ok(textContents.includes('最近更新：刚刚'));
  assert.ok(textContents.includes('配置：model gpt-5.4 · sandbox workspace-write · approvalPolicy on-request'));
  assert.equal(textContents.includes('会话：sessionKind assistant · 恢复态 是 · 中断恢复 是'), false);

  const buttons = collectButtons(card.body);
  assert.deepEqual(buttons.map((button) => ({
    text: String((button.text as Record<string, unknown>)?.content ?? ''),
    type: button.type,
    behaviors: button.behaviors
  })), [
    {
      text: '查询当前状态',
      type: 'primary',
      behaviors: [
        {
          type: 'callback',
          value: {
            kind: 'query_current_task',
            cardSource: 'assistant_reply_receipt',
            turnId: 'turn-7'
          }
        }
      ]
    }
  ]);
});

test('assistant reply receipt can render a placeholder card without a query button before turn id is known', () => {
  const card = renderFeishuAssistantReplyReceiptCard({
    status: 'running',
    displayTitle: '助手 · 执行中',
    phaseLabel: '执行中',
    activityLabel: '正在推进当前任务',
    updatedLabel: '0 秒前'
  } as any) as {
    header?: { title?: { content?: string } };
    body?: { elements?: Array<Record<string, unknown>> };
  };

  assert.equal(card.header?.title?.content, '助手 · 执行中');

  const textContents = collectTextContents(card.body);
  assert.ok(textContents.includes('当前阶段：执行中'));
  assert.ok(textContents.includes('最近动作：正在推进当前任务'));
  assert.ok(textContents.includes('最近更新：0 秒前'));
  assert.deepEqual(collectButtons(card.body), []);
});

test('reply status card shows interrupting state without exposing a second interrupt button', () => {
  const card = renderFeishuReplyStatusCard(({
    taskId: 'T1',
    status: 'interrupting',
    displayTitle: 'T1 · 打断中',
    phaseLabel: '打断中',
    activityLabel: '正在停止当前任务',
    updatedLabel: '1 分钟前'
  } as any)) as {
    header?: { title?: { content?: string } };
    body?: { elements?: Array<Record<string, unknown>> };
  };

  assert.equal(card.header?.title?.content, 'T1 · 打断中');

  const textContents = collectTextContents(card.body);
  assert.ok(textContents.includes('当前阶段：打断中'));
  assert.ok(textContents.includes('最近动作：正在停止当前任务'));
  assert.ok(textContents.includes('最近更新：1 分钟前'));

  const buttons = collectButtons(card.body);
  assert.deepEqual(buttons, [
    {
      tag: 'button',
      type: 'default',
      text: { tag: 'plain_text', content: '查询任务进展' },
      behaviors: [{ type: 'callback', value: { kind: 'query_current_task', cardSource: 'reply_status_card' } }]
    }
  ]);
});

test('approval card keeps the full command inside a collapsible panel and exposes allow or deny callbacks', () => {
  const card = renderFeishuApprovalCard({
    taskId: 'T26',
    state: 'pending',
    reason: '排查卡住现象',
    cwd: 'D:\\Quantitative_Trading',
    previewLines: ['python tmp_daily_skip_predownload.py', '$proc = Start-Process ...'],
    command: "python tmp_daily_skip_predownload.py\n$proc = Start-Process ..."
  }) as {
    header?: { title?: { content?: string } };
    body?: { elements?: Array<Record<string, unknown>> };
  };

  assert.equal(card.header?.title?.content, '任务 T26 等待审批');

  const textContents = collectTextContents(card.body);
  assert.ok(textContents.some((content) => content.includes('排查卡住现象')));
  assert.ok(textContents.some((content) => content.includes('D:\\Quantitative_Trading')));
  assert.ok(textContents.some((content) => content.includes('python tmp_daily_skip_predownload.py')));
  assert.equal(textContents.some((content) => content.includes('$proc = Start-Process ...')), true);

  const collapsiblePanels = collectNodesByTag(card.body, 'collapsible_panel');
  assert.equal(collapsiblePanels.length, 1);
  assert.equal((collapsiblePanels[0] as any)?.header?.title?.content, '展开查看完整命令');

  const buttons = collectButtons(card.body);
  const byLabel = new Map(
    buttons.map((button) => [String((button.text as Record<string, unknown>)?.content ?? ''), button])
  );
  assert.deepEqual(byLabel.get('允许')?.behaviors, [
    { type: 'callback', value: { kind: 'allow_waiting_task', taskId: 'T26', cardSource: 'approval_card' } }
  ]);
  assert.deepEqual(byLabel.get('拒绝')?.behaviors, [
    { type: 'callback', value: { kind: 'deny_waiting_task', taskId: 'T26', cardSource: 'approval_card' } }
  ]);
});

test('approval card renders file-change approvals with generic content labels', () => {
  const card = renderFeishuApprovalCard(({
    taskId: 'T27',
    state: 'pending',
    kind: 'file_change',
    reason: '需要写入项目目录',
    detailLabel: '范围',
    detailValue: 'D:\\CodexLark\\src',
    previewLines: ['范围: D:\\CodexLark\\src'],
    command: '原因: 需要写入项目目录\n范围: D:\\CodexLark\\src'
  } as unknown) as Parameters<typeof renderFeishuApprovalCard>[0]) as {
    header?: { title?: { content?: string } };
    body?: { elements?: Array<Record<string, unknown>> };
  };

  assert.equal(card.header?.title?.content, '任务 T27 等待审批');

  const textContents = collectTextContents(card.body);
  assert.ok(textContents.some((content) => content.includes('需要写入项目目录')));
  assert.ok(textContents.some((content) => content.includes('范围：D:\\CodexLark\\src')));
  assert.ok(textContents.some((content) => content.includes('审批内容')));

  const collapsiblePanels = collectNodesByTag(card.body, 'collapsible_panel');
  assert.equal(collapsiblePanels.length, 1);
  assert.equal((collapsiblePanels[0] as any)?.header?.title?.content, '展开查看完整审批内容');

  const buttons = collectButtons(card.body);
  const byLabel = new Map(
    buttons.map((button) => [String((button.text as Record<string, unknown>)?.content ?? ''), button])
  );
  assert.deepEqual(byLabel.get('允许')?.behaviors, [
    { type: 'callback', value: { kind: 'allow_waiting_task', taskId: 'T27', cardSource: 'approval_card' } }
  ]);
  assert.deepEqual(byLabel.get('拒绝')?.behaviors, [
    { type: 'callback', value: { kind: 'deny_waiting_task', taskId: 'T27', cardSource: 'approval_card' } }
  ]);
});

test('status card renders launcher mode with recent project dirs and submit action', () => {
  const card = renderFeishuModeStatusCard({
    mode: 'launcher',
    displayMode: 'assistant',
    recentProjectDirs: ['D:\\Workspace\\Project', 'D:\\Workspace\\Alpha'],
    launcherSelectedCwd: 'D:\\Workspace\\Project'
  } as any) as {
    schema?: string;
    body?: { elements?: Array<Record<string, unknown>> };
  };

  assert.equal(card.schema, '2.0');

  const textContents = collectTextContents(card.body);
  const buttons = collectButtons(card.body);
  const inputs = collectNodesByTag(card.body, 'input');
  const forms = collectNodesByTag(card.body, 'form');
  const byLabel = new Map(
    buttons.map((button) => [String((button.text as Record<string, unknown>)?.content ?? ''), button])
  );

  assert.ok(textContents.some((content) => content.includes('启动 Codex 编程窗口')));
  assert.ok(textContents.some((content) => content.includes('D:\\Workspace\\Project')));
  assert.ok(textContents.some((content) => content.includes('D:\\Workspace\\Alpha')));
  assert.equal(inputs.length, 1);
  assert.equal(forms.length, 1);
  assert.equal(forms[0]?.name, 'launch_coding_form');
  assert.equal(inputs[0]?.name, 'project_cwd');
  assert.equal(inputs[0]?.default_value, 'D:\\Workspace\\Project');
  assert.equal(byLabel.get('使用 D:\\Workspace\\Project')?.type, 'primary');
  assert.deepEqual(byLabel.get('使用 D:\\Workspace\\Project')?.behaviors, [
    { type: 'callback', value: { kind: 'select_recent_cwd', cwd: 'D:\\Workspace\\Project' } }
  ]);
  assert.equal(byLabel.get('启动编程窗口')?.action_type, 'form_submit');
  assert.equal(byLabel.get('启动编程窗口')?.name, 'submit_launch_coding');
  assert.equal(byLabel.get('启动编程窗口')?.behaviors, undefined);
});

test('status card renders launcher error state while keeping recent dirs and input', () => {
  const card = renderFeishuModeStatusCard({
    mode: 'launcher_with_error',
    displayMode: 'assistant',
    recentProjectDirs: ['D:\\Workspace\\Project'],
    launcherSelectedCwd: 'D:\\Workspace\\Project',
    launcherDraftCwd: 'D:\\Broken',
    launcherError: '目录不存在，请重新输入。'
  } as any) as {
    schema?: string;
    body?: { elements?: Array<Record<string, unknown>> };
  };

  assert.equal(card.schema, '2.0');

  const textContents = collectTextContents(card.body);
  const inputs = collectNodesByTag(card.body, 'input');
  assert.ok(textContents.some((content) => content.includes('目录不存在，请重新输入。')));
  assert.ok(textContents.some((content) => content.includes('D:\\Workspace\\Project')));
  assert.equal(inputs[0]?.default_value, 'D:\\Broken');
});

test('status card renders local codex takeover button in status mode', () => {
  const card = renderFeishuModeStatusCard({
    displayMode: 'coding',
    currentCodingTaskId: 'T9',
    currentTaskLifecycle: 'IDLE'
  } as any) as {
    schema?: string;
    body?: { elements?: Array<Record<string, unknown>> };
  };

  assert.equal(card.schema, '2.0');

  const buttons = collectButtons(card.body);
  const byLabel = new Map(
    buttons.map((button) => [String((button.text as Record<string, unknown>)?.content ?? ''), button])
  );

  assert.equal(byLabel.get('接管本地 Codex')?.type, 'primary');
  assert.deepEqual(byLabel.get('接管本地 Codex')?.behaviors, [
    { type: 'callback', value: { kind: 'open_takeover_picker' } }
  ]);
  assert.ok(byLabel.has('切换当前任务'));
  assert.ok(byLabel.has('新建任务'));
  assert.ok(byLabel.has('返回启动卡'));
});

test('status card renders takeover picker first page with selected task, snapshot timestamp, and forward navigation', () => {
  const card = renderFeishuModeStatusCard({
    mode: 'takeover_picker',
    displayMode: 'assistant',
    takeoverPickerTasks: [
      {
        taskId: 'T11',
        lifecycle: 'IDLE',
        cwd: 'D:\\Workspace\\Alpha',
        summary: '任务摘要 1',
        updatedAtLabel: '2026-04-21 10:00'
      },
      {
        taskId: 'T12',
        lifecycle: 'RUNNING_TURN',
        cwd: 'D:\\Workspace\\Beta',
        summary: '任务摘要 2',
        updatedAtLabel: '2026-04-21 09:58'
      },
      {
        taskId: 'T13',
        lifecycle: 'WAITING_USER',
        cwd: 'D:\\Workspace\\Gamma',
        summary: '任务摘要 3',
        updatedAtLabel: '2026-04-21 09:55'
      },
      {
        taskId: 'T14',
        lifecycle: 'FAILED',
        cwd: 'D:\\Workspace\\Delta',
        summary: '任务摘要 4',
        updatedAtLabel: '2026-04-21 09:50'
      },
      {
        taskId: 'T15',
        lifecycle: 'IDLE',
        cwd: 'D:\\Workspace\\Omega',
        summary: '任务摘要 5',
        updatedAtLabel: '2026-04-21 09:40'
      }
    ],
    takeoverPickerPage: 0,
    takeoverPickerTotalPages: 3,
    takeoverPickerSelectedTaskId: 'T12',
    takeoverPickerSnapshotUpdatedAt: '2026-04-21 10:01'
  } as any) as {
    schema?: string;
    body?: { elements?: Array<Record<string, unknown>> };
  };

  assert.equal(card.schema, '2.0');

  const textContents = collectTextContents(card.body);
  const buttons = collectButtons(card.body);
  const byLabel = new Map(
    buttons.map((button) => [String((button.text as Record<string, unknown>)?.content ?? ''), button])
  );

  assert.ok(textContents.some((content) => content.includes('本地 Codex 接管')));
  assert.ok(textContents.some((content) => content.includes('快照时间：2026-04-21 10:01')));
  assert.ok(textContents.some((content) => content.includes('已选中：T12')));
  assert.ok(textContents.some((content) => content.includes('任务摘要：任务摘要 1')));
  assert.ok(textContents.some((content) => content.includes('任务摘要：任务摘要 5')));
  assert.equal(byLabel.has('上一页'), false);
  assert.equal(byLabel.get('下一页')?.type, 'primary');
  assert.deepEqual(byLabel.get('下一页')?.behaviors, [
    { type: 'callback', value: { kind: 'takeover_picker_next_page' } }
  ]);
  assert.deepEqual(byLabel.get('刷新列表')?.behaviors, [
    { type: 'callback', value: { kind: 'refresh_takeover_picker' } }
  ]);
  assert.deepEqual(byLabel.get('确认接管')?.behaviors, [
    { type: 'callback', value: { kind: 'confirm_takeover_task' } }
  ]);
  assert.deepEqual(byLabel.get('返回状态卡')?.behaviors, [
    { type: 'callback', value: { kind: 'return_to_status' } }
  ]);
  assert.deepEqual(byLabel.get('选择 T12')?.behaviors, [
    { type: 'callback', value: { kind: 'pick_takeover_task', taskId: 'T12' } }
  ]);
});

test('status card renders empty takeover picker state', () => {
  const card = renderFeishuModeStatusCard({
    mode: 'takeover_picker',
    displayMode: 'assistant',
    takeoverPickerTasks: [],
    takeoverPickerPage: 0,
    takeoverPickerTotalPages: 1
  } as any) as {
    schema?: string;
    body?: { elements?: Array<Record<string, unknown>> };
  };

  const textContents = collectTextContents(card.body);
  assert.ok(textContents.some((content) => content.includes('当前没有可接管的本地 Codex Coding 会话')));
});

test('status card renders takeover picker last page with backward navigation only', () => {
  const card = renderFeishuModeStatusCard({
    mode: 'takeover_picker',
    displayMode: 'assistant',
    takeoverPickerTasks: [
      {
        taskId: 'T21',
        lifecycle: 'IDLE',
        cwd: 'D:\\Workspace\\Tail',
        summary: '最后一页'
      }
    ],
    takeoverPickerPage: 2,
    takeoverPickerTotalPages: 3
  } as any) as {
    schema?: string;
    body?: { elements?: Array<Record<string, unknown>> };
  };

  const buttons = collectButtons(card.body);
  const byLabel = new Map(
    buttons.map((button) => [String((button.text as Record<string, unknown>)?.content ?? ''), button])
  );

  assert.deepEqual(byLabel.get('上一页')?.behaviors, [
    { type: 'callback', value: { kind: 'takeover_picker_prev_page' } }
  ]);
  assert.equal(byLabel.has('下一页'), false);
});

test('status card renders takeover picker error state without hiding refresh controls', () => {
  const card = renderFeishuModeStatusCard({
    mode: 'takeover_picker',
    displayMode: 'assistant',
    takeoverPickerTasks: [],
    takeoverPickerPage: 0,
    takeoverPickerTotalPages: 1,
    takeoverPickerError: '扫描本地 Codex 会话失败。'
  } as any) as {
    schema?: string;
    body?: { elements?: Array<Record<string, unknown>> };
  };

  const textContents = collectTextContents(card.body);
  const buttons = collectButtons(card.body);
  const byLabel = new Map(
    buttons.map((button) => [String((button.text as Record<string, unknown>)?.content ?? ''), button])
  );

  assert.ok(textContents.some((content) => content.includes('扫描本地 Codex 会话失败。')));
  assert.ok(byLabel.has('刷新列表'));
  assert.ok(byLabel.has('返回状态卡'));
});
