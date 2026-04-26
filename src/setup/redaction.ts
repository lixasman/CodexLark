const SECRET_ENV_FIELD_NAMES = new Set(["FEISHU_APP_SECRET"]);
const REDACTED_VALUE = "[redacted]";

function isSecretNameValueRecord(record: Record<string, unknown>): boolean {
  return typeof record.name === "string" && SECRET_ENV_FIELD_NAMES.has(record.name) && Object.hasOwn(record, "value");
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const record = value as Record<string, unknown>;
  const redactNameValue = isSecretNameValueRecord(record);
  return Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => !SECRET_ENV_FIELD_NAMES.has(key))
      .map(([key, entryValue]) => [key, redactNameValue && key === "value" ? REDACTED_VALUE : redactValue(entryValue)])
  );
}

export function redactSetupSecretsForOutput<T>(value: T): T {
  return redactValue(value) as T;
}
