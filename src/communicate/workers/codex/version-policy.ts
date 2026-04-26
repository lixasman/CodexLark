import { type CommunicateRuntimeWarning } from '../../protocol/task-types';

export type KnownBadCodexVersionPolicy = {
  code: 'known_bad_codex_version';
  version: string;
  summary: string;
  suggestedAction: string;
};

export type SupportedCodexVersionCheck =
  | {
      supported: true;
      version: string;
    }
  | {
      supported: false;
      version?: string;
      reason: 'missing_version' | 'known_bad_version' | 'version_too_old';
      policy?: KnownBadCodexVersionPolicy;
    };

export const KNOWN_BAD_CODEX_VERSION_RUNTIME_WARNING_MESSAGE =
  '当前Codex版本存在不兼容问题，请尽快升级到最新版本';
export const MIN_SUPPORTED_CODEX_VERSION = '0.111.0';

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

type ParsedVersionToken = {
  release: number[];
  prerelease: Array<number | string> | null;
};

function parseVersionToken(input: string): ParsedVersionToken | null {
  const cleaned = input.trim();
  const match = cleaned.match(/^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  const release = match[1]!.split('.').map((part) => Number.parseInt(part, 10));
  if (!release.every((part) => Number.isFinite(part))) return null;
  const prerelease = match[2]
    ? match[2].split('.').map((part) => (/^\d+$/.test(part) ? Number.parseInt(part, 10) : part))
    : null;
  return { release, prerelease };
}

function compareParsedVersionTokens(left: ParsedVersionToken, right: ParsedVersionToken): number {
  const length = Math.max(left.release.length, right.release.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = left.release[index] ?? 0;
    const rightValue = right.release[index] ?? 0;
    if (leftValue !== rightValue) {
      return leftValue > rightValue ? 1 : -1;
    }
  }
  if (left.prerelease == null && right.prerelease == null) return 0;
  if (left.prerelease == null) return 1;
  if (right.prerelease == null) return -1;
  const prereleaseLength = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < prereleaseLength; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftIsNumber = typeof leftIdentifier === 'number';
    const rightIsNumber = typeof rightIdentifier === 'number';
    if (leftIsNumber && rightIsNumber) {
      return leftIdentifier > rightIdentifier ? 1 : -1;
    }
    if (leftIsNumber) return -1;
    if (rightIsNumber) return 1;
    return String(leftIdentifier).localeCompare(String(rightIdentifier));
  }
  return 0;
}

function compareVersionTokens(left: string, right: string): number | null {
  const leftParts = parseVersionToken(left);
  const rightParts = parseVersionToken(right);
  if (!leftParts || !rightParts) return null;
  return compareParsedVersionTokens(leftParts, rightParts);
}

export function verifySupportedCodexVersion(version: string | null | undefined): SupportedCodexVersionCheck {
  const normalized = typeof version === 'string' ? version.trim() : '';
  if (!normalized) {
    return {
      supported: false,
      reason: 'missing_version'
    };
  }

  const minimumVersionCompare = compareVersionTokens(normalized, MIN_SUPPORTED_CODEX_VERSION);
  if (minimumVersionCompare == null || minimumVersionCompare < 0) {
    return {
      supported: false,
      version: normalized,
      reason: 'version_too_old'
    };
  }

  const policy = getKnownBadCodexVersionPolicy(normalized);
  if (!policy) {
    return {
      supported: true,
      version: normalized
    };
  }

  return {
    supported: false,
    version: normalized,
    reason: 'known_bad_version',
    policy
  };
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
