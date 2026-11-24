import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";
import type { CasinoAdapter } from "../casino/types.js";
import { invalidateCatalog } from "./catalog-cache.js";
import { syncImageChange } from "./game-images.js";

const slugify = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const CHUNK = 400;

/**
 * Sincroniza o catálogo do agregador em lote (são milhares de jogos): cria provedores e jogos novos,
 * atualiza nome, capa e dados de launch dos existentes e desativa (sem apagar) os que saíram do
 * catálogo ou foram desligados lá. Fica o que o admin decidiu: ativo/inativo, categoria, capa
 * enviada, nome do provedor, "Em alta" e ordem. Catálogo vazio = erro e nada é alterado.
 */
export async function syncCatalog(adapter: CasinoAdapter) {
  const incoming = await adapter.listGames(); // falha da API vira erro antes de mexer no banco
  if (!incoming.length) throw new AppError("O agregador devolveu um catálogo vazio — nada foi alterado.", 502, "EMPTY_CATALOG");
  const list = [...new Map(incoming.map((g) => [g.externalId, g])).values()];

  // Provedores: cria os novos, completa o logo onde ainda não há um (logo trocado no admin fica) e
  // grava a carteira do agregador — ela decide se o provedor aparece no site (services/casino-wallets.ts).
  const logoBySlug = new Map<string, string>(), walletBySlug = new Map<string, string>();
  for (const g of list) {
    if (g.providerLogo && !logoBySlug.has(g.providerSlug)) logoBySlug.set(g.providerSlug, g.providerLogo);
    if (g.providerWallet && !walletBySlug.has(g.providerSlug)) walletBySlug.set(g.providerSlug, g.providerWallet);
  }
  const provBySlug = new Map((await prisma.gameProvider.findMany()).map((p) => [p.slug, p]));
  let providersCreated = 0;
  for (const g of list) {
    if (provBySlug.has(g.providerSlug)) continue;
    const p = await prisma.gameProvider.create({
      data: { slug: g.providerSlug, name: g.providerName, logoUrl: logoBySlug.get(g.providerSlug) ?? null, wallet: walletBySlug.get(g.providerSlug) ?? null },
    });
    provBySlug.set(p.slug, p);
    providersCreated++;
  }
  for (const p of provBySlug.values()) {
    const logo = logoBySlug.get(p.slug), wallet = walletBySlug.get(p.slug);
    const data: { logoUrl?: string; wallet?: string } = {};
    if (!p.logoUrl && logo) data.logoUrl = logo;
    if (wallet && p.wallet !== wallet) data.wallet = wallet; // a carteira é da PlayFivers: sempre segue a API
    if (Object.keys(data).length) await prisma.gameProvider.update({ where: { id: p.id }, data });
  }

  const existing = await prisma.game.findMany({ where: { integration: adapter.key } });
  const byExt = new Map(existing.map((e) => [e.externalId ?? "", e]));
  const slugs = new Set((await prisma.game.findMany({ select: { slug: true } })).map((s) => s.slug));
  // Nomes se repetem entre provedores (ex.: Fortune Tiger "clone" e "oficial"): o slug ganha o código.
  const uniqueSlug = (name: string, ext: string) => {
    const base = (slugify(name) || slugify(ext) || "jogo").slice(0, 70);
    let s = base;
    if (slugs.has(s)) s = `${base}-${slugify(ext)}`.slice(0, 80);
    for (let i = 2; slugs.has(s); i++) s = `${base}-${i}`;
    slugs.add(s);
    return s;
  };

  const toCreate: Prisma.GameCreateManyInput[] = [];
  const toUpdate: { id: string; data: Prisma.GameUpdateInput }[] = [];
  for (const g of list) {
    const providerId = provBySlug.get(g.providerSlug)!.id;
    const apiMeta = { original: Boolean(g.original), code: g.code ?? g.externalId, provider: g.providerRaw ?? g.providerName };
    const meta = JSON.stringify(apiMeta);
    const cur = byExt.get(g.externalId);
    if (!cur) {
      toCreate.push({
        slug: uniqueSlug(g.name, g.externalId),
        name: g.name,
        category: g.category,
        providerId,
        imageUrl: g.imageUrl ?? null,
        hasDemo: g.hasDemo ?? false,
        isLive: g.isLive ?? false,
        isActive: g.active !== false,
        integration: adapter.key,
        externalId: g.externalId,
        meta,
      });
      continue;
    }
    // Categoria/ao vivo não são reescritas: depois da 1ª carga, quem manda é o admin.
    const data: Prisma.GameUpdateInput = {};
    if (cur.name !== g.name) data.name = g.name;
    if (cur.providerId !== providerId) data.provider = { connect: { id: providerId } };
    // Capa e meta: preserva miniatura baixada, capa do admin e a marca de "sem capa na CDN" (ver syncImageChange).
    const img = syncImageChange(cur, g.imageUrl ?? null, apiMeta);
    if (cur.meta !== img.meta) data.meta = img.meta;
    if (img.imageUrl !== undefined && img.imageUrl !== cur.imageUrl) data.imageUrl = img.imageUrl;
    if (g.active === false && cur.isActive) data.isActive = false;
    if (Object.keys(data).length) toUpdate.push({ id: cur.id, data });
  }

  for (let i = 0; i < toCreate.length; i += CHUNK) await prisma.game.createMany({ data: toCreate.slice(i, i + CHUNK) });
  for (let i = 0; i < toUpdate.length; i += CHUNK) {
    await prisma.$transaction(toUpdate.slice(i, i + CHUNK).map((u) => prisma.game.update({ where: { id: u.id }, data: u.data })));
  }
  const seen = new Set(list.map((g) => g.externalId));
  const gone = existing.filter((e) => e.isActive && !seen.has(e.externalId ?? "")).map((e) => e.id);
  for (let i = 0; i < gone.length; i += CHUNK) {
    await prisma.game.updateMany({ where: { id: { in: gone.slice(i, i + CHUNK) } }, data: { isActive: false } });
  }
  invalidateCatalog();
  return { total: list.length, created: toCreate.length, updated: toUpdate.length, deactivated: gone.length, providersCreated };
}
