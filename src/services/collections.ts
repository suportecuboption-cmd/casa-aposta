import { prisma } from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";
import { providerDisplayName } from "../lib/provider-name.js";
import { coversFirst } from "./game-images.js";
import { getWalletSettings } from "./casino-wallets.js";
import { assertCanReceiveRewards, creditBonus, isUniqueViolation, wageredTotal } from "./loyalty.js";

/**
 * Coleções (admin → Fidelidade → Coleções): álbuns de cartas em que cada carta é um jogo do catálogo.
 * O jogador ganha um pacote a cada R$ X apostados, abre e recebe cartas sorteadas; completou o álbum,
 * resgata o prêmio uma vez. Ajustes (R$ por pacote, cartas por pacote) ficam no SiteSetting "collections".
 */

const KEY = "collections";
const r2 = (v: number) => Math.round(v * 100) / 100;
const brl = (v: number) => `R$ ${v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export interface CollectionsSettings {
  enabled: boolean;
  packEvery: number; // R$ apostados para ganhar 1 pacote
  cardsPerPack: number;
  updatedAt: string | null;
  updatedBy: string | null;
}
const defaults = (): CollectionsSettings => ({ enabled: true, packEvery: 100, cardsPerPack: 3, updatedAt: null, updatedBy: null });

/** Pura: lê os ajustes gravados (quebrado = padrão). */
export function parseCollectionsSettings(value: string | null | undefined): CollectionsSettings {
  const d = defaults();
  if (!value) return d;
  try {
    const j = JSON.parse(value);
    if (!j || typeof j !== "object") return d;
    const every = Number(j.packEvery), per = Number(j.cardsPerPack);
    return {
      enabled: typeof j.enabled === "boolean" ? j.enabled : d.enabled,
      packEvery: Number.isFinite(every) && every >= 1 ? r2(every) : d.packEvery,
      cardsPerPack: Number.isInteger(per) && per >= 1 && per <= 10 ? per : d.cardsPerPack,
      updatedAt: typeof j.updatedAt === "string" ? j.updatedAt : null,
      updatedBy: typeof j.updatedBy === "string" ? j.updatedBy : null,
    };
  } catch {
    return d;
  }
}

export async function getCollectionsSettings() {
  const row = await prisma.siteSetting.findUnique({ where: { key: KEY } });
  return parseCollectionsSettings(row?.value);
}

export async function saveCollectionsSettings(input: { enabled: boolean; packEvery: number; cardsPerPack: number }, adminId: string) {
  const cfg: CollectionsSettings = { ...input, packEvery: r2(input.packEvery), updatedAt: new Date().toISOString(), updatedBy: adminId };
  const value = JSON.stringify(cfg);
  await prisma.$transaction([
    prisma.siteSetting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } }),
    prisma.adminAuditLog.create({ data: { adminId, action: "COLLECTIONS_SETTINGS", target: KEY, payload: JSON.stringify(input) } }),
  ]);
  return cfg;
}

/** Pura: pacotes ganhos pelo total apostado, já abertos, disponíveis e quanto falta para o próximo. */
export function packsState(wagered: number, packEvery: number, opened: number) {
  const earned = packEvery > 0 ? Math.floor(wagered / packEvery + 1e-9) : 0;
  return { earned, opened, available: Math.max(0, earned - opened), nextIn: packEvery > 0 ? r2(packEvery * (earned + 1) - wagered) : 0 };
}

/**
 * Pura: sorteia as cartas de um pacote — sem repetir dentro do pacote e com mais chance (60%) de vir
 * uma carta que o jogador ainda não tem (assim dá para completar o álbum).
 */
export function pickCards(all: string[], owned: Set<string>, n: number, rng: () => number = Math.random): string[] {
  const pool = [...new Set(all)];
  const out: string[] = [];
  while (out.length < n && pool.length) {
    const missing = pool.filter((id) => !owned.has(id));
    const from = missing.length && rng() < 0.6 ? missing : pool;
    const id = from[Math.min(from.length - 1, Math.floor(rng() * from.length))];
    out.push(id);
    pool.splice(pool.indexOf(id), 1);
  }
  return out;
}

const CARD_INCLUDE = {
  cards: {
    orderBy: { position: "asc" as const },
    include: { game: { select: { id: true, name: true, imageUrl: true, isActive: true, provider: { select: { name: true } } } } },
  },
};

/** O que o jogador vê (sem login: os álbuns, todas as cartas fechadas). */
export async function playerCollections(userId: string | null) {
  const settings = await getCollectionsSettings();
  const cols = await prisma.collection.findMany({ where: { active: true }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], include: CARD_INCLUDE });
  const owned = new Map<string, number>();
  const claimed = new Set<string>();
  let wagered = 0, opened = 0;
  if (userId) {
    const [cards, claims, loyalty, w] = await Promise.all([
      prisma.playerCard.findMany({ where: { userId }, select: { cardId: true, count: true } }),
      prisma.collectionClaim.findMany({ where: { userId }, select: { collectionId: true } }),
      prisma.playerLoyalty.findUnique({ where: { userId } }),
      wageredTotal(userId),
    ]);
    cards.forEach((c) => owned.set(c.cardId, c.count));
    claims.forEach((c) => claimed.add(c.collectionId));
    opened = loyalty?.packsOpened ?? 0;
    wagered = w;
  }
  return {
    enabled: settings.enabled,
    packEvery: settings.packEvery,
    cardsPerPack: settings.cardsPerPack,
    loggedIn: !!userId,
    wagered,
    packs: packsState(wagered, settings.packEvery, opened),
    collections: cols.map((c) => {
      const cards = c.cards.map((card) => ({
        id: card.id, gameId: card.gameId, name: card.game.name, imageUrl: card.game.imageUrl,
        provider: providerDisplayName(card.game.provider.name), playable: card.game.isActive, count: owned.get(card.id) ?? 0,
      }));
      const have = cards.filter((x) => x.count > 0).length;
      return {
        id: c.id, name: c.name, description: c.description, reward: Number(c.reward),
        total: cards.length, owned: have, complete: cards.length > 0 && have === cards.length, claimed: claimed.has(c.id), cards,
      };
    }),
  };
}

/** Abre um pacote: gasta 1 dos pacotes ganhos e entrega as cartas sorteadas. */
export async function openPack(userId: string) {
  const settings = await getCollectionsSettings();
  if (!settings.enabled) throw new AppError("As coleções estão desligadas no momento.", 409, "COLLECTIONS_DISABLED");
  await assertCanReceiveRewards(userId);
  const cards = await prisma.collectionCard.findMany({
    where: { collection: { active: true } },
    select: { id: true, collectionId: true, game: { select: { name: true, imageUrl: true } } },
  });
  if (!cards.length) throw new AppError("Nenhuma coleção aberta no momento.", 409, "NO_COLLECTIONS");
  const wagered = await wageredTotal(userId);
  const { earned } = packsState(wagered, settings.packEvery, 0);
  return prisma.$transaction(async (tx) => {
    await tx.playerLoyalty.upsert({ where: { userId }, create: { userId }, update: {} });
    // incremento condicional: dois cliques ao mesmo tempo não abrem mais pacotes do que o ganho
    const ok = await tx.playerLoyalty.updateMany({ where: { userId, packsOpened: { lt: earned } }, data: { packsOpened: { increment: 1 } } });
    if (ok.count === 0) throw new AppError(`Sem pacotes para abrir. A cada ${brl(settings.packEvery)} apostados você ganha um.`, 409, "NO_PACKS");
    const ownedRows = await tx.playerCard.findMany({ where: { userId }, select: { cardId: true } });
    const ownedSet = new Set(ownedRows.map((r) => r.cardId));
    const byId = new Map(cards.map((c) => [c.id, c]));
    const out: { cardId: string; collectionId: string; name: string; imageUrl: string | null; isNew: boolean }[] = [];
    for (const id of pickCards(cards.map((c) => c.id), ownedSet, settings.cardsPerPack)) {
      const isNew = !ownedSet.has(id);
      await tx.playerCard.upsert({ where: { userId_cardId: { userId, cardId: id } }, create: { userId, cardId: id }, update: { count: { increment: 1 } } });
      ownedSet.add(id);
      const c = byId.get(id)!;
      out.push({ cardId: id, collectionId: c.collectionId, name: c.game.name, imageUrl: c.game.imageUrl, isNew });
    }
    const loyalty = await tx.playerLoyalty.findUniqueOrThrow({ where: { userId } });
    return { cards: out, packs: packsState(wagered, settings.packEvery, loyalty.packsOpened) };
  });
}

/** Resgata o prêmio de uma coleção completa (uma vez por coleção). */
export async function claimCollection(userId: string, collectionId: string) {
  const col = await prisma.collection.findUnique({ where: { id: collectionId }, include: { cards: { select: { id: true } } } });
  if (!col || !col.active) throw new AppError("Coleção não encontrada", 404, "NOT_FOUND");
  const reward = Number(col.reward);
  if (reward <= 0) throw new AppError("Essa coleção não tem prêmio para resgatar.", 409, "NO_REWARD");
  await assertCanReceiveRewards(userId);
  const have = await prisma.playerCard.count({ where: { userId, cardId: { in: col.cards.map((c) => c.id) } } });
  if (!col.cards.length || have < col.cards.length) throw new AppError(`Faltam ${col.cards.length - have} cartas para completar a coleção.`, 409, "NOT_COMPLETE");
  try {
    const balance = await prisma.$transaction(async (tx) => {
      await tx.collectionClaim.create({ data: { userId, collectionId, amount: reward } });
      return creditBonus(tx, userId, reward, `colecao:${collectionId}`, { source: "collection", collection: col.name });
    });
    return { ok: true, collection: col.name, amount: reward, balance };
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError("Você já resgatou o prêmio dessa coleção.", 409, "ALREADY_CLAIMED");
    throw e;
  }
}

/* ───────────── admin ───────────── */

export async function collectionsAdminView() {
  const [settings, cols, claims] = await Promise.all([
    getCollectionsSettings(),
    prisma.collection.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], include: CARD_INCLUDE }),
    prisma.collectionClaim.groupBy({ by: ["collectionId"], _count: { _all: true }, _sum: { amount: true } }),
  ]);
  const byCol = new Map(claims.map((c) => [c.collectionId, { count: c._count._all, total: Number(c._sum.amount ?? 0) }]));
  return {
    settings,
    collections: cols.map((c) => ({
      id: c.id, name: c.name, description: c.description, reward: Number(c.reward), active: c.active, sortOrder: c.sortOrder,
      claims: byCol.get(c.id) ?? { count: 0, total: 0 },
      cards: c.cards.map((card) => ({ gameId: card.gameId, name: card.game.name, imageUrl: card.game.imageUrl, provider: providerDisplayName(card.game.provider.name), active: card.game.isActive })),
    })),
  };
}

export interface CollectionInput { name: string; description: string; reward: number; active: boolean; sortOrder: number; gameIds: string[] }

export async function saveCollection(id: string | null, input: CollectionInput, adminId: string) {
  const gameIds = [...new Set(input.gameIds)];
  const found = await prisma.game.findMany({ where: { id: { in: gameIds } }, select: { id: true } });
  if (found.length !== gameIds.length) throw new AppError("Algum jogo escolhido não existe mais. Atualize a tela.", 400, "VALIDATION");
  const data = { name: input.name, description: input.description, reward: r2(input.reward), active: input.active, sortOrder: input.sortOrder };
  const saved = await prisma.$transaction(async (tx) => {
    const col = id ? await tx.collection.update({ where: { id }, data }) : await tx.collection.create({ data });
    // cartas: sai o que não está mais na lista (e as cartas dos jogadores junto), o resto fica na ordem nova
    await tx.collectionCard.deleteMany({ where: { collectionId: col.id, gameId: { notIn: gameIds } } });
    for (const [position, gameId] of gameIds.entries()) {
      await tx.collectionCard.upsert({
        where: { collectionId_gameId: { collectionId: col.id, gameId } },
        create: { collectionId: col.id, gameId, position },
        update: { position },
      });
    }
    await tx.adminAuditLog.create({
      data: { adminId, action: id ? "COLLECTION_UPDATE" : "COLLECTION_CREATE", target: col.id, payload: JSON.stringify({ name: col.name, cards: gameIds.length, reward: data.reward, active: data.active }) },
    });
    return col;
  });
  return saved;
}

export async function deleteCollection(id: string, adminId: string) {
  const col = await prisma.collection.findUnique({ where: { id }, select: { name: true } });
  if (!col) throw new AppError("Coleção não encontrada", 404, "NOT_FOUND");
  await prisma.$transaction([
    prisma.collection.delete({ where: { id } }),
    prisma.adminAuditLog.create({ data: { adminId, action: "COLLECTION_DELETE", target: id, payload: col.name } }),
  ]);
  return { ok: true };
}

const GAME_PICK = { id: true, name: true, imageUrl: true, featured: true, sortOrder: true, isActive: true, provider: { select: { name: true, wallet: true } } } as const;
type Picked = { id: string; name: string; imageUrl: string | null; isActive: boolean; provider: { name: string; wallet: string | null } };
// "active" = o jogo aparece no site (ativo e de uma carteira habilitada na PlayFivers)
const pickView = (g: Picked, enabled: Set<string>) =>
  ({ id: g.id, name: g.name, imageUrl: g.imageUrl, provider: providerDisplayName(g.provider.name), active: g.isActive && enabled.has(g.provider.wallet ?? "") });
const enabledWallets = async () => new Set((await getWalletSettings()).enabled);

/** Pura: ordem da busca — nome que começa com o texto, depois ativo, depois com capa, depois o nome. */
export function rankSearch<T extends { name: string; isActive: boolean; imageUrl: string | null }>(games: T[], q: string): T[] {
  const n = q.trim().toLowerCase();
  const score = (g: T) => (g.name.toLowerCase().startsWith(n) ? 0 : 4) + (g.isActive ? 0 : 2) + (g.imageUrl ? 0 : 1);
  return [...games].sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name, "pt-BR"));
}

/** Busca de jogos por nome para montar o álbum. */
export async function searchGamesForCollections(q: string) {
  const [games, enabled] = await Promise.all([prisma.game.findMany({ where: { name: { contains: q } }, select: GAME_PICK, take: 300 }), enabledWallets()]);
  const onSite = games.map((g) => ({ ...g, isActive: g.isActive && enabled.has(g.provider.wallet ?? "") }));
  return rankSearch(onSite, q).slice(0, 30).map((g) => pickView(g, enabled));
}

/** Sugestão de cartas: os N primeiros jogos ativos de um provedor, com capa antes. */
export async function autofillGames(providerSlug: string, count: number) {
  const games = await prisma.game.findMany({
    where: { isActive: true, provider: { slug: providerSlug } },
    select: GAME_PICK,
    orderBy: [{ featured: "desc" }, { sortOrder: "asc" }, { name: "asc" }],
  });
  const enabled = await enabledWallets();
  return coversFirst(games).slice(0, count).map((g) => pickView(g, enabled));
}
