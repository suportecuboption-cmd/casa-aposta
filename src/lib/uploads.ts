import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { AppError } from "./errors.js";

const here = path.dirname(fileURLToPath(import.meta.url)); // src/lib (dev) | dist/lib (build)

/** Pasta onde imagens enviadas pelo admin ficam; servida em /uploads/. */
export const uploadsDir = path.join(here, "..", "..", "uploads");

export function ensureUploadsDir(): void {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

const MAX_BYTES = 6 * 1024 * 1024; // 6 MB

export type UploadKind = "banner" | "provider" | "game";

/** Decodifica uma data URL base64 e grava como arquivo, retornando o caminho público. */
export function saveDataUrl(
  dataUrl: string,
  kind: UploadKind = "banner",
): { url: string; bytes: number } {
  const m = /^data:(image\/[a-z+]+);base64,([\s\S]+)$/i.exec(dataUrl);
  if (!m) throw new AppError("Data URL inválida", 400);
  const ext = EXT[m[1].toLowerCase()];
  if (!ext) throw new AppError("Formato de imagem não suportado", 400);

  const buf = Buffer.from(m[2], "base64");
  if (buf.length === 0) throw new AppError("Imagem vazia", 400);
  if (buf.length > MAX_BYTES) throw new AppError("Imagem muito grande (máx 6 MB)", 400);

  ensureUploadsDir();
  const name = `${kind}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${ext}`;
  fs.writeFileSync(path.join(uploadsDir, name), buf);
  return { url: `/uploads/${name}`, bytes: buf.length };
}
