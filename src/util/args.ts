export type ArgValue = string | number | boolean;

export type ParsedArgs = {
  command: string | null;
  flags: Record<string, ArgValue>;
  positionals: string[];
};

function coerceValue(raw: string): ArgValue {
  const trimmed = raw.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  const n = Number(trimmed);
  if (!Number.isNaN(n) && trimmed !== "") return n;
  return raw;
}

// Minimal argv parser:
// - command: first positional (if any)
// - flags: --key value / --key=value / --flag (boolean true)
export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, ArgValue> = {};
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? "";
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const eqIdx = token.indexOf("=");
    if (eqIdx > -1) {
      const key = token.slice(2, eqIdx);
      const value = token.slice(eqIdx + 1);
      flags[key] = coerceValue(value);
      continue;
    }

    const key = token.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }
    flags[key] = coerceValue(next);
    i++;
  }

  const command = positionals.length > 0 ? positionals[0] ?? null : null;
  const rest = positionals.slice(command ? 1 : 0);
  return { command, flags, positionals: rest };
}

export function flagString(flags: Record<string, ArgValue>, key: string): string | undefined {
  const v = flags[key];
  if (v == null) return undefined;
  return String(v);
}

export function flagNumber(flags: Record<string, ArgValue>, key: string): number | undefined {
  const v = flags[key];
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function flagBoolean(flags: Record<string, ArgValue>, key: string): boolean | undefined {
  const v = flags[key];
  if (v == null) return undefined;
  if (typeof v === "boolean") return v;
  const s = String(v).toLowerCase();
  if (s === "1" || s === "true" || s === "yes" || s === "y") return true;
  if (s === "0" || s === "false" || s === "no" || s === "n") return false;
  return undefined;
}

