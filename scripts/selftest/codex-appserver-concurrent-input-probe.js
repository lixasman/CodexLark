const path = require('node:path');

const { createCodexAppSession } = require(path.join(__dirname, '..', '..', 'dist', 'communicate', 'workers', 'codex', 'app-session'));

process.env.COMMUNICATE_CODEX_ALLOW_CONCURRENT_INPUT = '1';

const promptA = 'Please investigate the current state of AI development.';
const promptB = "At the end of the output, print today's date (2026-03-18).";
const sessionCwd = (process.env.CODEX_SELFTEST_CWD ?? '').trim() || path.resolve(__dirname, '..', '..');
const explicitCodexExe = (process.env.CODEX_CLI_EXE ?? '').trim();

let command;
if (explicitCodexExe) {
  command = [explicitCodexExe];
} else if (process.platform === 'win32') {
  command = ['codex.cmd'];
} else {
  command = ['codex'];
}

const session = createCodexAppSession({
  taskId: 'T-probe',
  cwd: sessionCwd,
  command,
  enableLogWindow: false,
  onEvent: (event) => {
    if (event.type === 'task_finished') {
      const output = String(event.output || '');
      const ok = output.includes('2026-03-18');
      console.log('=== FINAL OUTPUT ===');
      console.log(output);
      console.log('=== RESULT ===');
      console.log(ok ? 'SUPPORTED' : 'NOT SUPPORTED');
      process.exit(ok ? 0 : 2);
    }

    if (event.type === 'task_failed') {
      console.error('TASK FAILED');
      console.error(event.output || '');
      process.exit(1);
    }
  }
});

session.start();

setTimeout(() => {
  session.sendReply({ action: 'input_text', text: promptA });
  setTimeout(() => {
    try {
      session.sendReply({ action: 'input_text', text: promptB });
    } catch (error) {
      console.error('SECOND INPUT ERROR', String(error));
    }
  }, 5000);
}, 500);

setTimeout(() => {
  console.error('TIMEOUT');
  process.exit(3);
}, 10 * 60 * 1000);
