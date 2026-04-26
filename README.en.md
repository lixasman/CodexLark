# CodexLark

> The stable Feishu entry point for Codex on your own machine.

CodexLark is a personal workflow product for Windows + PowerShell that lets you start, resume, control, and take over local Codex sessions from Feishu.

It pulls the high-frequency, high-friction actions into one place: recovering context, continuing existing work, switching the active mode, checking status, and taking over running tasks.

The primary documentation is still in Simplified Chinese: [README.md](./README.md).

## Why Use It

- recover context and task entry points after restarts
- keep the active mode, active task, and common actions visible in status cards
- continue, take over, and manage existing work without digging through local terminals
- use Feishu as the long-lived control surface for local Codex work, not just a temporary message tunnel

## Built for Daily Use

### Session Recovery

The local session registry keeps thread context and task entry points alive across restarts, so you can pick up where you left off.

### Status Card Control

Unified status cards keep the current mode, current task, and common actions visible. That works better day to day than a purely text-driven command flow.

### Task Takeover

Existing tasks stay actionable from Feishu, so you do not have to hunt through local terminals to find the right entry point.

## Who It Is For

- You want to start or continue local Codex work from Feishu
- You primarily work on Windows and accept PowerShell as the default environment
- You care about session recovery, status-card control, and task takeover
- You want something stable enough for repeated daily use, not just another integration demo

## Who It Is Not For

- Teams looking for a cross-platform shared service
- Users who cannot accept an elevated PowerShell restart flow for the Feishu long-connection process
- Anyone who only wants a generic chat-to-agent integration layer
- Anyone looking for a hosted multi-user service instead of a local Windows workflow

## Typical Workflow

1. Sign in to your Windows machine and start the Feishu long-connection service
2. Open the Feishu thread and use the status card or launcher to resume an existing task or start a new one
3. Continue input, switch modes, check status, or stop a task
4. Take over an existing task when needed
5. Keep local work moving in the same thread

If you are new to the project, start with the `.exe` installer path below. Use the source/manual path only when you want to evaluate, develop, or troubleshoot from the repository.

## Feishu Shortcut: Project Card

When the chat gets long and the main status card has moved out of sight, send exactly `项目卡` in the same Feishu thread to bring the current main control card back to the bottom.

Use it when:

- you want to switch projects or create a new project without scrolling back through the thread
- you want the current control entry point close to the latest conversation
- the current card is a launcher, status card, or error-state card and you want to recall that same view

Rules:

- the keyword is exactly `项目卡`
- surrounding spaces are accepted, but extra words are not
- the message is not forwarded to the active Codex task as normal chat input
- the service re-sends the card that matches the current thread state instead of forcing a launcher view

Think of it as "send the current status card to the bottom again."

## Source / Manual Environment Requirements

If you are using the `.exe` installer as a normal download user, you can skip this section. These prerequisites mainly apply to source builds, manual troubleshooting, and developer workflows.

- Windows
- PowerShell
- Node.js 24 or newer
- a working `codex` CLI, or an explicit `CODEX_CLI_EXE`
- a Feishu app configured for long connection

## Minimal Feishu Open Platform Setup

The `.exe` installer and the source installer can prepare the local runtime, but they do not configure your Feishu app for you.

Before running the installer or starting the runtime manually, make sure the Feishu side is prepared:

- create an internal app and save its `App ID` / `App Secret`
- add the bot capability to the app
- grant at least these permissions: `im:message`, `im:message.p2p_msg:readonly`, `im:message.group_at_msg:readonly`, `im:message:send_as_bot`, `im:resource`, `im:message:update`
- under event settings, choose long connection and subscribe to `im.message.receive_v1`
- if you want interactive status-card buttons, also finish the card callback setup; the code currently handles it through `card.action.trigger`, which is callback-related rather than a normal message event subscription
- create and publish an app version; permission and event changes often do not take effect before publication
- add yourself and your test targets to the availability scope; for group testing, also add the bot to the test group

If the Feishu console labels differ from this README, search by permission code or event code first.

## Recommended Install Path

### Product Installer Direction

- Normal download users should use `CodexLark-Setup-<version>.exe` plus the first-run wizard.
- The repository PowerShell installer remains available for source builds, local development, and troubleshooting, but it is no longer the main path for normal users.

Start from the path that matches your role:

- Normal download users: see [`docs/workflows/product-installer.md`](./docs/workflows/product-installer.md)
- Source / developer / release maintainer workflows: continue with this section, the quick-start section below, and [`docs/workflows/product-installer-release-gates.md`](./docs/workflows/product-installer-release-gates.md)

### Normal Download Users: Install the EXE

If you downloaded a release installer, you do not need to install Node.js first, run `npm install`, or build from source:

1. Download `CodexLark-Setup-<version>.exe`
2. Double-click the installer and finish the wizard
3. Use `Launch CodexLark` from the Start menu
4. The first-run wizard checks Codex CLI, login state, and Feishu settings, then stores `FEISHU_APP_SECRET` in local secure storage
5. On first launch, if the window says it does not know where to send the project card yet, send `项目卡` to the bot in Feishu to bind the thread

Common installed shortcuts:

- `Launch CodexLark`: start the Feishu long-connection runtime for daily use
- `Repair CodexLark`: re-check configuration, export diagnostics, or repair migration state
- `Uninstall CodexLark`: uninstall the product

The installed product files live under `Program Files\CodexLark`; runtime state, logs, diagnostics, and secret references live under `%LocalAppData%\CodexLark`. Normal users should not need to touch repository `dist\`, `node_modules\`, or build artifacts.

### Release Maintainers: Build the EXE

If you maintain releases and need to build the installer for download users, first make sure `Get-Command npm`, `Get-Command node`, and `Get-Command iscc` all work, then run:

```powershell
npm run build
powershell -ExecutionPolicy Bypass -File .\scripts\package\build-installer.ps1
```

Expected outcome:

- `artifacts\packaging\output\CodexLark-Setup-<version>.exe`
- bundled `node.exe`, prebuilt `dist\`, start/repair entries, and PowerShell bridge scripts
- installer-time runtime manifest sync before `first-run`

For a full release dry-run, see [`docs/workflows/product-installer-release-dry-run.md`](./docs/workflows/product-installer-release-dry-run.md).

### Source / Developers: Repository Installer

If you are evaluating or debugging from the repository, you can use `Install-CodexLark.ps1` from the repo root instead of walking the manual setup path.

Supported source-installer scope:

- ordinary personal Windows 10/11 PCs
- internet access available
- `winget` already installed
- Windows PowerShell 5.1 or PowerShell 7 in `FullLanguage` mode
- administrator elevation allowed
- Feishu app credentials already prepared through your out-of-band setup guide

Run:

```powershell
powershell -ExecutionPolicy Bypass -File .\Install-CodexLark.ps1
```

Expected outcome:

- checks `winget`, Node.js, Codex CLI, local env vars, and build prerequisites
- installs missing Node.js / Codex CLI automatically
- pauses for the user to complete Codex login
- runs `npm install`, `npm run build`, and `node .\scripts\doctor.cjs`
- lets you choose whether to enable logon autostart
- generates follow-up start / repair entry scripts

Notes:

- if `winget` is missing, the installer stops with a clear warning
- host-contract failures such as non-Windows hosts, restricted PowerShell language mode, or missing ScheduledTasks support fail early; AppLocker, WDAC, ExecutionPolicy, antivirus, or proxy blocks may still surface at the exact blocked operation
- startup of the Feishu long-connection runtime still requires user confirmation
- the manual quick-start path remains below for advanced users and troubleshooting

## Quick Evaluation

Before wiring real Feishu credentials, use the local evaluation path:

```powershell
npm install
npm run build
node .\scripts\doctor.cjs
npm test
```

Expected outcome:

- `npm run build` generates `dist/agent-cli.js`
- `node .\scripts\doctor.cjs` reports `PASS / FAIL / INFO` checks for the local prerequisites
- `npm test` runs the automated regression suite without relying on a fixed `.test-dist` directory

If this evaluation path already feels too constrained for your use case, the repository is probably outside your target shape.

## Quick Start (Manual / Advanced / Troubleshooting)

1. Set the required environment variables in your PowerShell session:

```powershell
$env:FEISHU_APP_ID = 'cli_xxx'
$env:FEISHU_APP_SECRET = 'replace_me'
$env:CODEX_CLI_EXE = 'codex'
$env:COMMUNICATE_ASSISTANT_CWD = $PWD.Path
$env:COMMUNICATE_FEISHU_IMAGE_DIR = '.\Communicate'
```

Optional debug backdoor if you want the old per-session PowerShell log windows back:

```powershell
$env:COMMUNICATE_CODEX_LOG_WINDOW = '1'
```

2. Build the project:

```powershell
npm run build
```

3. Run the local doctor script:

```powershell
node .\scripts\doctor.cjs
```

4. Start the Feishu long-connection runtime through the elevated helper:

```powershell
powershell -ExecutionPolicy Bypass -File .\run-admin-task.ps1
```

Without `COMMUNICATE_CODEX_LOG_WINDOW=1`, normal task startup keeps those per-session PowerShell log windows hidden. If hidden startup fails early, check `artifacts/feishu-realtest/feishu-longconn-bootstrap.err.log`.

5. Send a message from Feishu and verify that the local runtime creates or resumes the matching task.

## Autostart (Scheduled Task)

If you want the Feishu long-connection runtime to come back automatically after sign-in, use the repo scripts that register or remove the scheduled task.

Notes:

- the task still reuses `run-admin-task.ps1` for logs, PID handling, and the elevated startup path
- the install and uninstall scripts request elevation, so review them before you run them

Install:

```powershell
powershell -ExecutionPolicy Bypass -File .\Install-CodexLark-Autostart.ps1
```

Expected outcome:

- registers a scheduled task named `\CodexLark-FeishuLongConn`
- points that task to the repo-local `run-admin-task.ps1`

Remove:

```powershell
powershell -ExecutionPolicy Bypass -File .\Uninstall-CodexLark-Autostart.ps1
```

Expected outcome: the scheduled task is deleted and future sign-ins no longer auto-start the Feishu runtime.

## Security and Trust Model

- The Feishu long-connection process currently needs an elevated PowerShell start path, otherwise local Codex startup may fail with `spawn EPERM`.
- The project launches local Codex sessions on behalf of the current Windows user.
- Logs, registry snapshots, and saved images are written to local directories, so scrub them before sharing recordings or issue logs.

See [SECURITY.md](./SECURITY.md) for the current disclosure policy and sensitive areas.

## Architecture

```text
+-------------------+         +----------------------------------+
| Feishu            |         | Local Windows Workstation        |
| - text message    |         |                                  |
| - image message   | ----->  |  +----------------------------+  |
| - card action     |         |  | Feishu Long Connection     |  |
+-------------------+         |  | Runtime                    |  |
                              |  +-------------+--------------+  |
                              |                |                 |
                              |                v                 |
                              |  +----------------------------+  |
                              |  | Service / Router / Storage |  |
                              |  | - task routing             |  |
                              |  | - session recovery         |  |
                              |  | - status card state        |  |
                              |  +------+------+--------------+  |
                              |         |      |                 |
                              |         |      +----------------------------+
                              |         |                                   |
                              |         v                                   v
                              |  +-------------------+         +---------------------------+
                              |  | Codex CLI /       |         | Local Persistent Outputs  |
                              |  | App Session       |         | - logs/communicate/       |
                              |  | - start/resume    |         | - artifacts/              |
                              |  | - input/reply     |         | - Communicate/ images     |
                              |  +---------+---------+         +---------------------------+
                              |            |
                              |            v
                              |  +----------------------------+
                              |  | Feishu Reply / Status Card |
                              |  | - text reply               |
                              |  | - launcher/status card     |
                              |  +----------------------------+
                              +----------------------------------+
```

- Feishu provides the external input surface for text, images, and card actions
- the long-connection runtime receives events, acknowledges them, and forwards them into the local service layer
- the service, router, and storage layer manages routing, session recovery, status-card state, and persistence
- Codex CLI / app session handles the actual local Codex execution lifecycle
- local outputs keep logs, debug artifacts, PID files, and saved Feishu images for recovery and troubleshooting

## Current Limits

- Windows + PowerShell only
- No official npm package or formal release process yet
- No promise of shared multi-user deployment
- Chinese documentation is still the primary source of truth

## Repository Pointers

- `src/agent-cli.ts`: Feishu-focused CLI entry
- `src/communicate/`: Feishu channel, control flow, status cards, storage, Codex workers
- `scripts/doctor.cjs`: local prerequisite checker
- `scripts/selftest/`: manual validation scripts
- `tests/communicate/`: automated regression coverage
- `docs/`: public-facing supplementary documentation entry points
