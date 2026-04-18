import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCodexModelFromCommand } from '../../src/communicate/control/codex-model';

test('extracts model from --model flag forms used by codex command config', () => {
  assert.equal(extractCodexModelFromCommand(['codex', '--model', 'gpt-5.4']), 'gpt-5.4');
  assert.equal(extractCodexModelFromCommand(['codex', '--model=gpt-5.4-mini']), 'gpt-5.4-mini');
});

test('ignores missing or blank codex model flags', () => {
  assert.equal(extractCodexModelFromCommand(['codex']), undefined);
  assert.equal(extractCodexModelFromCommand(['codex', '--model', '']), undefined);
  assert.equal(extractCodexModelFromCommand(['codex', '--model=   ']), undefined);
});
