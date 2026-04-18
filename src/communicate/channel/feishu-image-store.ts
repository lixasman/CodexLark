import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, safeFilename } from '../../util/fs';

const DEFAULT_IMAGE_DIR = path.join(process.cwd(), 'Communicate');

function resolveImageDir(): string {
  const configured = process.env.COMMUNICATE_FEISHU_IMAGE_DIR;
  const trimmed = configured ? configured.trim() : '';
  return trimmed.length > 0 ? trimmed : DEFAULT_IMAGE_DIR;
}

export function ensureImageDir(): string {
  const dir = resolveImageDir();
  ensureDir(dir);
  return dir;
}

function extensionFromContentType(contentType?: string): string {
  if (!contentType) return 'jpg';
  const normalized = contentType.split(';')[0]?.trim().toLowerCase();
  if (normalized === 'image/png') return 'png';
  if (normalized === 'image/gif') return 'gif';
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return 'jpg';
  return 'jpg';
}

export function saveImage(input: { imageKey: string; data: Uint8Array; contentType?: string }): string {
  const dir = ensureImageDir();
  const ext = extensionFromContentType(input.contentType);
  const baseName = safeFilename(input.imageKey) || 'image';
  const fileName = `${baseName}.${ext}`;
  const fullPath = path.join(dir, fileName);
  fs.writeFileSync(fullPath, input.data);
  return fullPath;
}
