import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";
import { uploadsDir, ensureUploadsDir } from "../lib/uploads.js";
import { LOGO_HEIGHT } from "../schemas/brand.js";

/**
 * Marca do site (admin → Ajustes → Marca): nome, logo em texto ou em imagem (com versão para o tema
 * escuro) e ícone. Fica no BANCO (SiteSetting "brand") e em memória: o servidor escreve título,
 * favicon e logo direto no HTML do site do jogador — a marca padrão não "pisca" ao abrir e a prévia
 * de link no WhatsApp/Telegram já sai com o nome certo.
 */

const KEY = "brand";

export interface Brand {
  name: string; // nome do site: aba do navegador, textos do site, admin e faturas
  wordA: string; // logo em texto, parte 1 (cor do texto)
  wordB: string; // logo em texto, parte 2 (cor de destaque)
  logoUrl: string | null; // imagem da logo — substitui ícone e texto
  logoDarkUrl: string | null; // versão da imagem para o tema escuro (opcional)
  iconUrl: string | null; // ícone quadrado: favicon, atalho no celular, ao lado do texto e no admin
  logoHeight: number; // altura da imagem da logo no topo do site (px)
  supportUrl: string; // link do botão "Suporte" do menu do celular (vazio = sem botão)
}
export interface BrandConfig extends Brand {
  updatedAt: string | null;
  updatedBy: string | null;
}

export const DEFAULT_BRAND: Brand = {
  name: "casaAPOSTA", wordA: "casa", wordB: "APOSTA", logoUrl: null, logoDarkUrl: null, iconUrl: null, logoHeight: LOGO_HEIGHT.default, supportUrl: "",
};

const defaults = (): BrandConfig => ({ ...DEFAULT_BRAND, updatedAt: null, updatedBy: null });
let current: BrandConfig = defaults();
export const brandConfig = () => current;

/** Pura: só imagens enviadas para o nosso /uploads/ (nada de URL externa ou javascript:). */
export const isBrandImage = (u: unknown): u is string => typeof u === "string" && /^\/uploads\/[A-Za-z0-9._-]+$/.test(u);
/** Pura: link de suporte só http(s) (vai num href do site). */
export const isSupportUrl = (u: unknown): u is string => typeof u === "string" && /^https?:\/\/[^\s"'<>]+$/i.test(u);
const clampHeight = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(LOGO_HEIGHT.max, Math.max(LOGO_HEIGHT.min, Math.round(v))) : LOGO_HEIGHT.default;

/** Pura: lê o JSON gravado; o que faltar ou vier quebrado volta ao padrão. */
export function parseBrand(value: string | null | undefined): BrandConfig {
  const d = defaults();
  if (!value) return d;
  let j: Record<string, unknown>;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return d;
    j = parsed;
  } catch {
    return d;
  }
  const text = (v: unknown, dflt: string) => (typeof v === "string" ? v.trim() : dflt);
  const img = (v: unknown) => (isBrandImage(v) ? v : null);
  return {
    name: text(j.name, d.name) || d.name,
    wordA: text(j.wordA, d.wordA),
    wordB: text(j.wordB, d.wordB),
    logoUrl: img(j.logoUrl),
    logoDarkUrl: img(j.logoDarkUrl),
    iconUrl: img(j.iconUrl),
    logoHeight: clampHeight(j.logoHeight),
    supportUrl: isSupportUrl(j.supportUrl) ? j.supportUrl : "",
    updatedAt: typeof j.updatedAt === "string" ? j.updatedAt : null,
    updatedBy: typeof j.updatedBy === "string" ? j.updatedBy : null,
  };
}

export async function loadBrandConfig() {
  const row = await prisma.siteSetting.findUnique({ where: { key: KEY } });
  current = parseBrand(row?.value);
  return current;
}

/** Pura: só os campos da marca (o que o site e a tela pública recebem). */
export const publicBrand = (b: Brand = current): Brand => ({
  name: b.name, wordA: b.wordA, wordB: b.wordB, logoUrl: b.logoUrl, logoDarkUrl: b.logoDarkUrl, iconUrl: b.iconUrl, logoHeight: b.logoHeight, supportUrl: b.supportUrl,
});

/** Pura: aplica o formulário (campo ausente = mantém; imagem null = remove). */
export function mergeBrand(cur: Brand, input: Partial<Brand>): Brand {
  const pick = <K extends keyof Brand>(k: K): Brand[K] => (input[k] !== undefined ? (input[k] as Brand[K]) : cur[k]);
  return publicBrand({
    name: pick("name").trim() || cur.name,
    wordA: pick("wordA").trim(),
    wordB: pick("wordB").trim(),
    logoUrl: pick("logoUrl"),
    // sem logo principal não existe "versão para o tema escuro"
    logoDarkUrl: pick("logoUrl") ? pick("logoDarkUrl") : null,
    iconUrl: pick("iconUrl"),
    logoHeight: clampHeight(pick("logoHeight")),
    supportUrl: isSupportUrl(pick("supportUrl").trim()) ? pick("supportUrl").trim() : "",
  });
}

export async function saveBrand(input: Partial<Brand>, adminId: string) {
  const before = publicBrand(current);
  const next = mergeBrand(before, input);
  const cfg: BrandConfig = { ...next, updatedAt: new Date().toISOString(), updatedBy: adminId };
  const value = JSON.stringify(cfg);
  await prisma.siteSetting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } });
  current = cfg;
  const changed = (Object.keys(next) as (keyof Brand)[]).filter((k) => next[k] !== before[k]);
  await prisma.adminAuditLog.create({ data: { adminId, action: "BRAND_UPDATE", target: KEY, payload: JSON.stringify({ changed, name: next.name }) } });
  return cfg;
}

/* ───────────────────────── HTML do site do jogador ───────────────────────── */

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

/** Hexágono padrão (o mesmo do HTML do site), usado quando não há ícone enviado. */
export const DEFAULT_ICON_SVG =
  '<svg class="ic" width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 2l8.66 5v10L12 22l-8.66-5V7L12 2z" fill="#f5333f" fill-opacity="0.18" stroke="#ec2440" stroke-width="1.7"/><path d="M12 7v10M7.5 9.5l9 5M16.5 9.5l-9 5" stroke="#ffc83d" stroke-width="1.7" stroke-linecap="round"/></svg>';

/** Pura: miolo do link da logo no topo do site (imagem, ou ícone + texto em duas cores). */
export function brandMarkup(b: Brand): string {
  const name = esc(b.name);
  if (b.logoUrl) {
    const h = ` style="--logo-h:${clampHeight(b.logoHeight)}px"`;
    return b.logoDarkUrl
      ? `<img class="logo logo-light" src="${esc(b.logoUrl)}" alt="${name}"${h}><img class="logo logo-dark" src="${esc(b.logoDarkUrl)}" alt="${name}"${h}>`
      : `<img class="logo" src="${esc(b.logoUrl)}" alt="${name}"${h}>`;
  }
  const icon = b.iconUrl ? `<img class="ic" src="${esc(b.iconUrl)}" alt="" width="26" height="26">` : DEFAULT_ICON_SVG;
  const text = b.wordA || b.wordB ? `${esc(b.wordA)}<b>${esc(b.wordB)}</b>` : name;
  return `${icon}<span class="wm">${text}</span>`;
}

/** JSON seguro dentro de <script> (sem "</script>" nem separadores de linha do JS). */
const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029); // quebram o JS dentro de <script>
const scriptJson = (v: unknown) =>
  JSON.stringify(v).replace(/</g, "\\u003c").split(LS).join("\\u2028").split(PS).join("\\u2029");

/**
 * Pura: aplica a marca no index.html do site — <title>, favicon, a logo entre <!--brand--> e
 * <!--/brand-->, o nome entre <!--brand-name--> e <!--/brand-name--> e window.SITE_BRAND para o script.
 */
export function renderPlayerHtml(template: string, b: Brand): string {
  const name = esc(b.name);
  let html = template
    .replace(/<title>[^<]*<\/title>/, `<title>${name}</title>`)
    .replace(/<!--brand-->[\s\S]*?<!--\/brand-->/g, `<!--brand-->${brandMarkup(b)}<!--/brand-->`)
    .replace(/<!--brand-name-->[\s\S]*?<!--\/brand-name-->/g, `<!--brand-name-->${name}<!--/brand-name-->`);
  if (b.iconUrl) html = html.replace(/<link rel="icon"[^>]*>/, `<link rel="icon" type="image/png" href="${esc(b.iconUrl)}" />`);
  // app instalável: nome no iPhone e ícone com versão (trocou o ícone na Marca, o atalho novo pega o novo)
  html = html
    .replace(/<meta name="apple-mobile-web-app-title" content="[^"]*"/, `<meta name="apple-mobile-web-app-title" content="${name}"`)
    .replace(/\/app\/icon-192\.png"/g, `/app/icon-192.png?v=${iconVersion(b)}"`);
  return html.replace("</head>", `<script>window.SITE_BRAND = ${scriptJson(publicBrand(b))};</script>\n</head>`);
}

/* ───────────────────────── imagens enviadas no admin ───────────────────────── */

export type BrandImageKind = "logo" | "icon";
const MAX_BYTES = 6 * 1024 * 1024;
const LOGO_PX = 192; // 3× a maior altura da logo no topo: nítida em tela de alta densidade
const ICON_PX = 256;

/**
 * Pura (sem disco): redesenha a imagem como PNG. O SVG vira PNG aqui — o arquivo servido nunca
 * carrega script. Logo: corta a borda vazia e reduz para 192 px de altura. Ícone: quadrado de 256 px.
 */
export async function renderBrandImage(buf: Buffer, kind: BrandImageKind, isSvg = false): Promise<Buffer> {
  const load = (input: Buffer, density?: number) => sharp(input, { limitInputPixels: 40_000_000, ...(density ? { density } : {}) });
  let density: number | undefined;
  if (isSvg) {
    // SVG não tem tamanho em pixels: desenha com densidade suficiente para ~400 px no maior lado.
    const meta = await load(buf).metadata();
    const side = Math.max(meta.width ?? 0, meta.height ?? 0) || 100;
    density = Math.min(1200, Math.max(36, Math.round((72 * 400) / side)));
  }
  let src = await load(buf, density).png().toBuffer();
  if (kind === "icon") {
    return load(src).resize(ICON_PX, ICON_PX, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png({ compressionLevel: 9 }).toBuffer();
  }
  // Borda vazia em volta deixa a logo minúscula na altura escolhida: corta (imagem lisa fica como veio).
  src = await load(src).trim().png().toBuffer().catch(() => src);
  return load(src).resize({ height: LOGO_PX, withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer();
}

/** Recebe a imagem do admin (data URL; PNG, JPG, WEBP, GIF, AVIF ou SVG), redesenha e grava em /uploads/. */
export async function processBrandImage(dataUrl: string, kind: BrandImageKind): Promise<{ url: string; width: number; height: number }> {
  const m = /^data:(image\/(?:png|jpe?g|webp|gif|avif|svg\+xml));base64,([\s\S]+)$/i.exec(dataUrl);
  if (!m) throw new AppError("Envie uma imagem PNG, JPG, WEBP, GIF, AVIF ou SVG", 400, "INVALID_IMAGE");
  const buf = Buffer.from(m[2], "base64");
  if (!buf.length) throw new AppError("Imagem vazia", 400, "INVALID_IMAGE");
  if (buf.length > MAX_BYTES) throw new AppError("Imagem muito grande (máx. 6 MB)", 400, "IMAGE_TOO_LARGE");
  let out: Buffer;
  try {
    out = await renderBrandImage(buf, kind, /svg/i.test(m[1]));
  } catch {
    throw new AppError("Não deu para ler essa imagem. Tente outro arquivo (PNG ou SVG).", 400, "INVALID_IMAGE");
  }
  const meta = await sharp(out).metadata();
  ensureUploadsDir();
  const file = `brand-${kind}-${crypto.createHash("sha1").update(out).digest("hex").slice(0, 12)}.png`;
  fs.writeFileSync(path.join(uploadsDir, file), out);
  return { url: `/uploads/${file}`, width: meta.width ?? 0, height: meta.height ?? 0 };
}

/* ───────────────────────── app instalável (PWA) ───────────────────────── */

/** Pura: versão do ícone (muda quando o ícone da Marca muda). */
export const iconVersion = (b: Brand) => crypto.createHash("sha1").update(b.iconUrl ?? "padrao").digest("hex").slice(0, 8);

/** Pura: manifest do app (nome e ícones da Marca). */
export function appManifest(b: Brand) {
  const v = iconVersion(b);
  return {
    id: "/app/",
    name: b.name,
    short_name: b.name.length > 12 ? b.name.slice(0, 12) : b.name,
    description: `${b.name}: esportes e cassino`,
    lang: "pt-BR",
    start_url: "/app/?app=1",
    scope: "/app/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#f7f3f4",
    theme_color: "#e5173f",
    icons: [
      { src: `/app/icon-192.png?v=${v}`, sizes: "192x192", type: "image/png", purpose: "any" },
      { src: `/app/icon-512.png?v=${v}`, sizes: "512x512", type: "image/png", purpose: "any" },
      { src: `/app/icon-maskable-512.png?v=${v}`, sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}

// Hexágono padrão sobre fundo branco (quadrado arredondado; no "maskable", fundo cheio com margem de segurança).
const HEX = '<path d="M12 2l8.66 5v10L12 22l-8.66-5V7L12 2z" fill="#fde3e8" stroke="#ec2440" stroke-width="1.7" stroke-linejoin="round"/><path d="M12 7v10M7.5 9.5l9 5M16.5 9.5l-9 5" stroke="#f0a800" stroke-width="1.7" stroke-linecap="round"/>';
const defaultIconSvg = (size: number, maskable: boolean) => {
  const k = maskable ? 0.62 : 0.78, off = (24 - 24 * k) / 2;
  const bg = maskable ? '<rect width="24" height="24" fill="#fff"/>' : '<rect width="24" height="24" rx="5.3" fill="#fff"/>';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}">${bg}<g transform="translate(${off} ${off}) scale(${k})">${HEX}</g></svg>`;
};

const iconCache = new Map<string, Buffer>();
const CLEAR = { r: 0, g: 0, b: 0, alpha: 0 };

/** Ícone do app em PNG: o ícone enviado na Marca (ou o hexágono padrão), em 192 ou 512 px. */
export async function renderAppIcon(b: Brand, size: number, maskable: boolean): Promise<Buffer> {
  const key = `${b.iconUrl ?? "padrao"}:${size}:${maskable ? "m" : "a"}`;
  const hit = iconCache.get(key);
  if (hit) return hit;
  let out: Buffer;
  const file = b.iconUrl && isBrandImage(b.iconUrl) ? path.join(uploadsDir, path.basename(b.iconUrl)) : null;
  if (file && fs.existsSync(file)) {
    const inner = Math.round(size * (maskable ? 0.62 : 1));
    const icon = await sharp(file).resize(inner, inner, { fit: "contain", background: CLEAR }).png().toBuffer();
    out = await sharp({ create: { width: size, height: size, channels: 4, background: maskable ? { r: 255, g: 255, b: 255, alpha: 1 } : CLEAR } })
      .composite([{ input: icon, gravity: "centre" }]).png().toBuffer();
  } else {
    out = await sharp(Buffer.from(defaultIconSvg(size, maskable))).png().toBuffer();
  }
  iconCache.set(key, out);
  return out;
}
