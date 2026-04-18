import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

function loadAgentCliSource(): string {
  return readFileSync(path.join(process.cwd(), 'src', 'agent-cli.ts'), 'utf8');
}

test('agent CLI help only exposes Feishu runtime commands after purification', () => {
  const source = loadAgentCliSource();

  assert.doesNotMatch(source, /skills-list/);
  assert.doesNotMatch(source, /skill-show/);
  assert.doesNotMatch(source, /open-gemini/);
  assert.doesNotMatch(source, /snapshot/);
  assert.doesNotMatch(source, /exec-smoke/);
  assert.doesNotMatch(source, /guard-smoke/);
  assert.doesNotMatch(source, /turndown-smoke/);
  assert.doesNotMatch(source, /chat-smoke/);
  assert.doesNotMatch(source, /chat-probe/);
  assert.doesNotMatch(source, /run --prompt/);
  assert.match(source, /feishu-longconn/);
  assert.match(source, /feishu-webhook/);
  assert.match(source, /allowKnownBadCodexVersion/);
});
