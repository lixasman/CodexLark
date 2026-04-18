import { type CommunicateRuntimeWarning } from '../../protocol/task-types';

export type KnownBadCodexVersionPolicy = {
  code: 'known_bad_codex_version';
  version: string;
  summary: string;
  suggestedAction: string;
};

export const KNOWN_BAD_CODEX_VERSION_RUNTIME_WARNING_MESSAGE =
  '当前Codex版本存在不兼容问题，请尽快升级到最新版本';

const KNOWN_BAD_CODEX_VERSION_POLICIES = new Map<string, KnownBadCodexVersionPolicy>([
  [
    '0.120.0',
    {
      code: 'known_bad_codex_version',
      version: '0.120.0',
      summary: 'Codex 0.120.0 is a known bad release that can interrupt tasks unexpectedly.',
      suggestedAction: 'Upgrade the local Codex CLI/app-server to the latest version, then retry.'
    }
  ]
]);

export function getKnownBadCodexVersionPolicy(version: string | null | undefined): KnownBadCodexVersionPolicy | null {
  if (typeof version !== 'string') return null;
  return KNOWN_BAD_CODEX_VERSION_POLICIES.get(version.trim()) ?? null;
}

export function formatKnownBadCodexVersionBlockMessage(input: { version: string }): string {
  return `检测到当前 Codex 版本 ${input.version} 属于已知不兼容版本，可能导致任务执行中被异常打断。${KNOWN_BAD_CODEX_VERSION_RUNTIME_WARNING_MESSAGE}，然后重试。`;
}

export function formatKnownBadCodexVersionFailureReason(version: string): string {
  return `current version ${version} is a known bad release that can interrupt tasks unexpectedly.`;
}

export function createKnownBadCodexVersionWarning(
  version: string | null | undefined,
  overrideActive = true
): CommunicateRuntimeWarning | undefined {
  const policy = getKnownBadCodexVersionPolicy(version);
  if (!policy) return undefined;
  return {
    code: policy.code,
    message: KNOWN_BAD_CODEX_VERSION_RUNTIME_WARNING_MESSAGE,
    version: policy.version,
    overrideActive: overrideActive ? true : undefined
  };
}
