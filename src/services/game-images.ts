import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import { prisma } from "../lib/prisma.js";
import { uploadsDir } from "../lib/uploads.js";
import { getWalletSettings } from "./casino-wallets.js";
import { invalidateCatalog } from "./catalog-cache.js";

/**
 * Capas dos jogos no NOSSO servidor. As da CDN da PlayFivers pesam 90–190 KB cada (uma vitrine de 60
 * cards passava de 7 MB) e a CDN deles recusa rajadas: baixamos uma vez, reduzimos para miniatura
 * (WEBP 360 px, ~20–30 KB) e servimos de /uploads/games/ com cache de 1 ano — o nome do arquivo leva
 * o hash do conteúdo, então trocar a imagem troca a URL. A URL original fica em meta.remoteImage.
 */

export const GAME_THUMBS_DIR = path.join(uploadsDir, "games");
export const GAME_THUMBS_URL = "/uploads/games/";
const THUMB_WIDTH = 360;
const CONCURRENCY = 4; // a CDN deles devolve 404 para rajadas grandes
const MAX_BYTES = 8 * 1024 * 1024;

export const isRemoteImage = (u: string | null | undefined): u is string => !!u && /^https?:\/\//i.test(u);
export const isLocalThumb = (u: string | null | undefined) => !!u && u.startsWith(GAME_THUMBS_URL);

/**
 * Pura — ordem da vitrine: "Em alta" e a ordem manual do admin continuam mandando; entre jogos
 * empatados nelas, os que têm capa vêm antes (boa parte do catálogo da PlayFivers não tem imagem).
 * Recebe a lista do banco já em featured desc, sortOrder asc, name asc: o sort do JS é estável, então
 * o nome continua desempatando. Ordena a própria lista.
 */
export function coversFirst<T extends { featured: boolean; sortOrder: number; imageUrl: string | null }>(games: T[]): T[] {
  const cover = (g: T) => (g.imageUrl ? 1 : 0);
  return games.sort((a, b) => Number(b.featured) - Number(a.featured) || a.sortOrder - b.sortOrder || cover(b) - cover(a));
}

/** Pura: nome do arquivo = id do jogo + hash do conteúdo. */
export const thumbName = (gameId: string, data: Buffer) =>
  `${gameId}-${crypto.createHash("sha1").update(data).digest("hex").slice(0, 10)}.webp`;

export function ensureThumbsDir() {
  fs.mkdirSync(GAME_THUMBS_DIR, { recursive: true });
}

/** A CDN não tem a capa (404): definitivo — vários provedores da PlayFivers apontam para arquivos inexistentes. */
class MissingImage extends Error {}

/** Pura: lê o JSON do meta do jogo (vazio/quebrado = {}). */
export function parseMeta(meta: string | null | undefined): Record<string, unknown> {
  try {
    const m = meta ? JSON.parse(meta) : {};
    return m && typeof m === "object" && !Array.isArray(m) ? m : {};
  } catch {
    return {};
  }
}

async function download(url: string): Promise<Buffer> {
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 800 * attempt));
    let r: Response;
    try {
      r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e); // rede/timeout: tenta de novo
      continue;
    }
    if (r.status === 404 || r.status === 410) throw new MissingImage(`HTTP ${r.status}`);
    if (r.ok) {
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length) throw new Error("arquivo vazio");
      if (buf.length > MAX_BYTES) throw new Error("imagem grande demais");
      return buf;
    }
    lastErr = `HTTP ${r.status}`;
    if (r.status !== 429 && r.status < 500) break; // outros 4xx: definitivo
  }
  throw new Error(lastErr || "falha no download");
}

/**
 * Pura: o que a sincronização do catálogo faz com a capa e o meta de um jogo que já existe.
 * - o meta da PlayFivers é regravado, mas o que o servidor guarda nele (remoteImage, imageMissing) fica;
 * - capa enviada pelo admin (/uploads/ fora de games/) nunca é trocada;
 * - miniatura nossa só volta para a CDN se a PlayFivers mudar a URL (arte nova → baixa de novo);
 * - capa que já deu 404 não volta a apontar para a MESMA URL quebrada (URL nova = tenta de novo).
 */
export function syncImageChange(
  cur: { imageUrl: string | null; meta: string | null },
  apiImageUrl: string | null,
  apiMeta: Record<string, unknown>,
): { imageUrl?: string | null; meta: string } {
  const m = parseMeta(cur.meta);
  const keep: Record<string, string> = {};
  if (typeof m.remoteImage === "string") keep.remoteImage = m.remoteImage;
  if (typeof m.imageMissing === "string") keep.imageMissing = m.imageMissing;
  const out: { imageUrl?: string | null; meta: string } = { meta: JSON.stringify({ ...apiMeta, ...keep }) };
  const api = apiImageUrl ?? null;
  if (isLocalThumb(cur.imageUrl)) {
    if (keep.remoteImage && api && keep.remoteImage !== api) out.imageUrl = api;
  } else if (cur.imageUrl?.startsWith("/uploads/")) {
    // capa enviada pelo admin: fica
  } else if (keep.imageMissing && keep.imageMissing === api) {
    // mesma URL que já deu 404: continua sem capa
  } else if (api !== cur.imageUrl) {
    out.imageUrl = api;
  }
  return out;
}

/** Miniatura: até 360 px de largura (não amplia), WEBP qualidade 72. Lança erro se não for imagem. */
export const makeThumb = (original: Buffer) =>
  sharp(original).resize({ width: THUMB_WIDTH, withoutEnlargement: true }).webp({ quality: 72 }).toBuffer();

async function localizeOne(g: { id: string; imageUrl: string | null; meta: string | null }): Promise<"ok" | "missing"> {
  if (!isRemoteImage(g.imageUrl)) return "ok";
  const meta = parseMeta(g.meta);
  let original: Buffer;
  try {
    original = await download(g.imageUrl);
  } catch (e) {
    if (!(e instanceof MissingImage)) throw e;
    // Sem capa na CDN: para de pedir a imagem (o card mostra o nome do jogo). A URL fica guardada:
    // se a PlayFivers trocar por outra na sincronização, tentamos de novo.
    await prisma.game.updateMany({
      where: { id: g.id, imageUrl: g.imageUrl },
      data: { imageUrl: null, meta: JSON.stringify({ ...meta, imageMissing: g.imageUrl }) },
    });
    return "missing";
  }
  const thumb = await makeThumb(original);
  const name = thumbName(g.id, thumb);
  await fs.promises.writeFile(path.join(GAME_THUMBS_DIR, name), thumb);
  const { imageMissing: _old, ...rest } = meta;
  // Só troca se a capa ainda for a mesma da CDN (o admin pode ter enviado outra enquanto baixava).
  await prisma.game.updateMany({
    where: { id: g.id, imageUrl: g.imageUrl },
    data: { imageUrl: GAME_THUMBS_URL + name, meta: JSON.stringify({ ...rest, remoteImage: g.imageUrl }) },
  });
  return "ok";
}

export interface ImageJob {
  running: boolean;
  total: number;
  done: number; // viraram miniatura
  missing: number; // a CDN não tem a capa (404)
  failed: number; // erro de rede/arquivo — continuam na CDN, dá para tentar de novo
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
}

const idle = (): ImageJob => ({ running: false, total: 0, done: 0, missing: 0, failed: 0, startedAt: null, finishedAt: null, lastError: null });
let job: ImageJob = idle();
export const imageJob = (): ImageJob => ({ ...job });

/** Jogos que aparecem no site (ativos, de carteira habilitada) com capa ainda na CDN — Em alta primeiro. */
async function visibleWhere() {
  const { enabled } = await getWalletSettings();
  return { isActive: true, provider: { wallet: { in: enabled } } };
}

export async function imageStats() {
  const visible = await visibleWhere();
  const [local, remote, missing] = await Promise.all([
    prisma.game.count({ where: { ...visible, imageUrl: { startsWith: GAME_THUMBS_URL } } }),
    prisma.game.count({ where: { ...visible, imageUrl: { startsWith: "http" } } }),
    prisma.game.count({ where: { ...visible, imageUrl: null, meta: { contains: '"imageMissing"' } } }),
  ]);
  return { local, remote, missing, job: imageJob() };
}

async function run() {
  ensureThumbsDir();
  const list = await prisma.game.findMany({
    where: { ...(await visibleWhere()), imageUrl: { startsWith: "http" } },
    select: { id: true, imageUrl: true, meta: true },
    orderBy: [{ featured: "desc" }, { sortOrder: "asc" }, { name: "asc" }],
  });
  job.total = list.length;
  let next = 0;
  let sinceFlush = 0;
  const worker = async () => {
    while (next < list.length) {
      const g = list[next++];
      try {
        if ((await localizeOne(g)) === "missing") job.missing++;
        else job.done++;
      } catch (e) {
        job.failed++;
        job.lastError = `${g.id}: ${e instanceof Error ? e.message : String(e)}`;
      }
      // a vitrine já vai usando as miniaturas prontas
      if (++sinceFlush >= 150) {
        sinceFlush = 0;
        invalidateCatalog();
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

/** Começa a baixar em segundo plano; se já estiver rodando, só devolve o andamento. */
export function startImageJob(onDone?: (j: ImageJob) => void): ImageJob {
  if (job.running) return imageJob();
  job = { ...idle(), running: true, startedAt: new Date().toISOString() };
  void run()
    .catch((e) => {
      job.lastError = e instanceof Error ? e.message : String(e);
    })
    .finally(() => {
      job.running = false;
      job.finishedAt = new Date().toISOString();
      invalidateCatalog();
      onDone?.(imageJob());
    });
  return imageJob();
}
