import { inspectCodexCliDependency, type CodexDependencyOptions, type CodexDependencyResult } from "./codex-dependency";
import { readSetupSettings, type SetupSettings } from "./config-store";
import { hasStoredSecretRecord, resolveSetupSecretValue } from "./secret-store";

export type ResolveLaunchEnvironmentSuccess = {
  ok: true;
  runtimeEnv: {
    FEISHU_APP_ID: string;
    FEISHU_APP_SECRET: string;
    CODEX_CLI_EXE: string;
  };
  codex: CodexDependencyResult;
  source: {
    codexCli: "env" | "settings" | "auto";
  };
};

export type ResolveLaunchEnvironmentFailure = {
  ok: false;
  failureCategory:
    | "configuration-missing"
    | "secret-store-failed"
    | "codex-missing"
    | "codex-install-failed"
    | "codex-unsupported-version"
    | "codex-login-missing";
  message: string;
  codex?: CodexDependencyResult;
};

export type ResolveLaunchEnvironmentResult = ResolveLaunchEnvironmentSuccess | ResolveLaunchEnvironmentFailure;

export type ResolveLaunchEnvironmentOptions = {
  env?: NodeJS.ProcessEnv;
  inspectCodexDependency?: (options?: CodexDependencyOptions) => Promise<CodexDependencyResult>;
  resolveSecretValue?: (reference: string, options?: { env?: NodeJS.ProcessEnv }) => Promise<string> | string;
};

export type ResolvedCodexDependency = {
  codex: CodexDependencyResult;
  env: NodeJS.ProcessEnv;
  source: ResolveLaunchEnvironmentSuccess["source"]["codexCli"];
};

function readEnvValue(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name];
  return typeof value === "string" ? value.trim() : "";
}

export function mergeStoredCodexCliEnv(
  env: NodeJS.ProcessEnv = process.env,
  settings: SetupSettings = readSetupSettings(env)
): NodeJS.ProcessEnv {
  if (!settings.codexCliPath) {
    return env;
  }

  const { CODEX_CLI_EXE: _ignoredCodexCliPath, ...rest } = env;
  return {
    ...rest,
    CODEX_CLI_EXE: settings.codexCliPath
  };
}

function removeCodexCliEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { CODEX_CLI_EXE: _ignoredCodexCliPath, ...rest } = env;
  return rest;
}

function formatCodexFailureMessage(codex: CodexDependencyResult): ResolveLaunchEnvironmentFailure["message"] {
  switch (codex.failureCategory) {
    case "install-failed":
      return "Codex CLI is installed but not healthy. Use Repair CodexLark to re-check it.";
    case "unsupported-version":
      return codex.version
        ? `Codex CLI version ${codex.version} is blocked by the current version policy.`
        : "Codex CLI version could not be verified.";
    case "login-missing":
      return "Codex CLI is installed, but no login marker was detected.";
    case "missing":
    default:
      return "Codex CLI could not be resolved from PATH or the stored advanced path.";
  }
}

function classifyCodexFailure(codex: CodexDependencyResult): ResolveLaunchEnvironmentFailure["failureCategory"] {
  switch (codex.failureCategory) {
    case "install-failed":
      return "codex-install-failed";
    case "unsupported-version":
      return "codex-unsupported-version";
    case "login-missing":
      return "codex-login-missing";
    case "missing":
    default:
      return "codex-missing";
  }
}

function resolveCodexSource(env: NodeJS.ProcessEnv, settings: SetupSettings): ResolveLaunchEnvironmentSuccess["source"]["codexCli"] {
  if (settings.codexCliPath) {
    return "settings";
  }
  if (readEnvValue("CODEX_CLI_EXE", env)) {
    return "env";
  }
  return "auto";
}

function shouldRetryWithoutStoredPath(result: CodexDependencyResult): boolean {
  return !result.present || result.failureCategory === "missing" || result.failureCategory === "install-failed";
}

function shouldPreferRetryResult(primary: CodexDependencyResult, fallback: CodexDependencyResult): boolean {
  if (!fallback.present) {
    return false;
  }

  if (!fallback.failureCategory) {
    return true;
  }

  return shouldRetryWithoutStoredPath(primary) && fallback.failureCategory !== primary.failureCategory;
}

export async function inspectStoredCodexCliDependency(options: {
  env?: NodeJS.ProcessEnv;
  settings?: SetupSettings;
  installWhenMissing?: boolean;
  inspectCodexDependency?: (options?: CodexDependencyOptions) => Promise<CodexDependencyResult>;
} = {}): Promise<ResolvedCodexDependency> {
  const env = options.env ?? process.env;
  const settings = options.settings ?? readSetupSettings(env);
  const installWhenMissing = options.installWhenMissing ?? false;
  const inspectCodexDependency = options.inspectCodexDependency ?? inspectCodexCliDependency;

  if (!settings.codexCliPath) {
    return {
      codex: await inspectCodexDependency({
        env,
        installWhenMissing
      }),
      env,
      source: resolveCodexSource(env, settings)
    };
  }

  const settingsEnv = mergeStoredCodexCliEnv(env, settings);
  const settingsResult = await inspectCodexDependency({
    env: settingsEnv,
    installWhenMissing
  });
  if (!shouldRetryWithoutStoredPath(settingsResult)) {
    return {
      codex: settingsResult,
      env: settingsEnv,
      source: "settings"
    };
  }

  const autoEnv = removeCodexCliEnv(env);
  const autoResult = await inspectCodexDependency({
    env: autoEnv,
    installWhenMissing
  });
  if (shouldPreferRetryResult(settingsResult, autoResult)) {
    return {
      codex: autoResult,
      env: autoEnv,
      source: resolveCodexSource(autoEnv, {
        ...settings,
        codexCliPath: undefined
      })
    };
  }

  return {
    codex: settingsResult,
    env: settingsEnv,
    source: "settings"
  };
}

export async function resolveLaunchEnvironment(
  options: ResolveLaunchEnvironmentOptions = {}
): Promise<ResolveLaunchEnvironmentResult> {
  const env = options.env ?? process.env;
  const settings = readSetupSettings(env);

  if (!settings.feishuAppId || !hasStoredSecretRecord(settings.feishuAppSecretRef, { env })) {
    return {
      ok: false,
      failureCategory: "configuration-missing",
      message: "Feishu App ID / App Secret is not configured in the canonical CodexLark setup store."
    };
  }

  const resolveSecretValue = options.resolveSecretValue ?? resolveSetupSecretValue;
  let feishuAppSecret: string;
  try {
    feishuAppSecret = String(
      await resolveSecretValue(settings.feishuAppSecretRef!, {
        env
      })
    );
  } catch (error) {
    return {
      ok: false,
      failureCategory: "secret-store-failed",
      message: String((error as Error)?.message ?? error)
    };
  }

  const { codex, env: codexEnv, source } = await inspectStoredCodexCliDependency({
    env,
    settings,
    inspectCodexDependency: options.inspectCodexDependency,
    installWhenMissing: false
  });

  if (!codex.present || codex.failureCategory) {
    return {
      ok: false,
      failureCategory: classifyCodexFailure(codex),
      message: formatCodexFailureMessage(codex),
      codex
    };
  }

  const codexCliExe =
    codex.resolvedPath ??
    (readEnvValue("CODEX_CLI_EXE", codexEnv) || settings.codexCliPath || "codex");
  return {
    ok: true,
    runtimeEnv: {
      FEISHU_APP_ID: settings.feishuAppId,
      FEISHU_APP_SECRET: feishuAppSecret,
      CODEX_CLI_EXE: codexCliExe
    },
    codex,
    source: {
      codexCli: source
    }
  };
}
