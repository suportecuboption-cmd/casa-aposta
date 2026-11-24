import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Role } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { brandSchema, brandUploadSchema } from "../schemas/index.js";
import { brandConfig, publicBrand, saveBrand, processBrandImage, renderPlayerHtml, appManifest, renderAppIcon } from "../services/brand.js";

const here = path.dirname(fileURLToPath(import.meta.url)); // src/routes (dev) | dist/routes (build)
const PLAYER_INDEX = path.join(here, "..", "..", "player-ui", "index.html");

/** index.html do site já com a marca (e em gzip); refeito quando o arquivo ou a marca mudam. */
let page: { key: string; html: string; gz: Buffer; etag: string } | null = null;
function playerPage() {
  const b = publicBrand(brandConfig());
  const key = `${fs.statSync(PLAYER_INDEX).mtimeMs}:${JSON.stringify(b)}`;
  if (!page || page.key !== key) {
    const html = renderPlayerHtml(fs.readFileSync(PLAYER_INDEX, "utf8"), b);
    page = { key, html, gz: zlib.gzipSync(html), etag: `"${crypto.createHash("sha1").update(html).digest("hex").slice(0, 16)}"` };
  }
  return page;
}

// Service worker do site: deixa o app instalável e guarda só a página, para abrir sem internet.
// API, saldo e jogos vão sempre direto para o servidor (nada de saldo velho em cache).
const SW_JS = `const CACHE = "site-v1";
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.add("/app/")).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || req.mode !== "navigate") return;
  e.respondWith(
    fetch(req)
      .then((res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put("/app/", copy)); } return res; })
      .catch(() => caches.match("/app/").then((r) => r || Response.error()))
  );
});
`;

export async function siteRoutes(app: FastifyInstance) {
  // Marca pública: o admin usa na tela de login; o site já recebe tudo escrito no HTML.
  app.get("/site/brand", async () => publicBrand());

  // Página do site do jogador com a marca aplicada (os demais arquivos de /app/ seguem estáticos).
  const servePlayer = async (req: FastifyRequest, reply: FastifyReply) => {
    const p = playerPage();
    reply
      .header("content-type", "text/html; charset=utf-8")
      .header("cache-control", "no-cache")
      .header("etag", p.etag)
      .header("vary", "accept-encoding");
    if (req.headers["if-none-match"] === p.etag) return reply.code(304).send();
    if (/\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))) return reply.header("content-encoding", "gzip").send(p.gz);
    return reply.send(p.html);
  };
  app.get("/app/", servePlayer);
  app.get("/app/index.html", servePlayer);

  // App instalável ("Instale o app" no menu do celular): manifest e ícones saem da Marca.
  app.get("/app/manifest.webmanifest", async (_req, reply) =>
    reply.header("content-type", "application/manifest+json; charset=utf-8").header("cache-control", "no-cache").send(JSON.stringify(appManifest(publicBrand()))));
  const icon = (size: number, maskable: boolean) => async (_req: FastifyRequest, reply: FastifyReply) =>
    reply.header("content-type", "image/png").header("cache-control", "public, max-age=86400").send(await renderAppIcon(publicBrand(), size, maskable));
  app.get("/app/icon-192.png", icon(192, false));
  app.get("/app/icon-512.png", icon(512, false));
  app.get("/app/icon-maskable-512.png", icon(512, true));
  app.get("/app/sw.js", async (_req, reply) =>
    reply.header("content-type", "application/javascript; charset=utf-8").header("cache-control", "no-cache").send(SW_JS));
}

const admin: Role[] = [Role.ADMIN];

/** Ajustes → Marca (só administrador). */
export async function siteAdminRoutes(app: FastifyInstance) {
  const view = async () => {
    const b = brandConfig();
    const by = b.updatedBy ? await prisma.user.findUnique({ where: { id: b.updatedBy }, select: { email: true } }) : null;
    return { ...publicBrand(b), updatedAt: b.updatedAt, updatedByEmail: by?.email ?? null };
  };

  app.get("/admin/site/brand", async (req) => {
    await app.authenticate(req, admin);
    return view();
  });

  app.put("/admin/site/brand", async (req) => {
    const jwt = await app.authenticate(req, admin);
    await saveBrand(brandSchema.parse(req.body), jwt.sub);
    return view();
  });

  // Logo ou ícone (data URL) → PNG redesenhado em /uploads/; a marca só muda ao salvar.
  app.post("/admin/site/brand/upload", { bodyLimit: 9 * 1024 * 1024 }, async (req) => {
    const jwt = await app.authenticate(req, admin);
    const { kind, dataUrl } = brandUploadSchema.parse(req.body);
    const saved = await processBrandImage(dataUrl, kind);
    await prisma.adminAuditLog.create({ data: { adminId: jwt.sub, action: "BRAND_IMAGE_UPLOAD", target: saved.url, payload: kind } });
    return saved;
  });
}
