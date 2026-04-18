import fs from "node:fs";
import path from "node:path";

export function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

export function writeJson(p: string, value: unknown): void {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(value, null, 2), "utf8");
}

export function writeText(p: string, value: string): void {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, value, "utf8");
}

export function appendLine(p: string, line: string): void {
  ensureDir(path.dirname(p));
  fs.appendFileSync(p, line.endsWith("\n") ? line : `${line}\n`, "utf8");
}

export function safeFilename(s: string): string {
  return s.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").slice(0, 120).trim();
}

export function nowIsoForPath(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return [
    d.getFullYear(),
    pad(d.getMonth() + 1),
    pad(d.getDate()),
    "_",
    pad(d.getHours()),
    pad(d.getMinutes()),
    pad(d.getSeconds())
  ].join("");
}

