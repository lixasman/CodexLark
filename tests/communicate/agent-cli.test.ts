import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../../src/util/args';
import { resolveFeishuRuntimeCliOptions, usage } from '../../src/agent-cli';

test('agent CLI usage mentions the temporary known-bad Codex override flag', () => {
  const text = usage();

  assert.match(text, /allowKnownBadCodexVersion/);
  assert.match(text, /临时|诊断|temporary|diagnostic/i);
});

test('agent CLI parses allowKnownBadCodexVersion into runtime options', () => {
  const parsed = parseArgs(['feishu-longconn', '--allowKnownBadCodexVersion']);

  assert.equal(resolveFeishuRuntimeCliOptions(parsed.flags).allowKnownBadCodexVersion, true);
});

test('agent CLI keeps allowKnownBadCodexVersion disabled by default', () => {
  const parsed = parseArgs(['feishu-longconn']);

  assert.equal(resolveFeishuRuntimeCliOptions(parsed.flags).allowKnownBadCodexVersion, false);
});
