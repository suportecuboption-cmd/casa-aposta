import { providerDisplayName } from "../lib/provider-name.js";
import crypto from "node:crypto";
import { Prisma, Role } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { winsFeedConfigSchema, type WinsFeedConfig } from "../schemas/wins.js";

export { winsFeedConfigSchema, type WinsFeedConfig };

/**
 * "Grandes vitórias recentes": vitrine pública montada SÓ com prêmios pagos de verdade
 * (lançamentos CASINO_WIN e BET_WIN do extrato). Rodada demo não passa pela carteira, então
 * nunca aparece; contas da equipe e bloqueadas ficam de fora; o nome sai mascarado.
 */

const SETTING_KEY = "winsFeed";
const DAY_MS = 86_400_000;
const CANDIDATE_CAP = 300; // lançamentos recentes avaliados por consulta
const CACHE_MS = 10_000;   // a vitrine é pública e consultada por todo visitante

export const DEFAULT_WINS_FEED: WinsFeedConfig = {
  enabled: true,
  minAmount: 50,
  casino: true,
  sports: true,
  maxAgeDays: 7,
  limit: 20,
};

/* ───────────────────────── funções puras (testadas) ───────────────────────── */

/** "Lucas Lima" → "Luc***". Mostra no máximo 3 caracteres e sempre esconde pelo menos 2. */
export function maskPlayer(displayName: string | null | undefined, email: string): string {
  const source = displayName?.trim() || email.split("@")[0] || "";
  const chars = Array.from(source.normalize("NFC")).filter((c) => /[\p{L}\p{N}]/u.test(c));
  if (!chars.length) return "Jog***";
  const shown = chars.slice(0, Math.min(3, Math.max(1, chars.length - 2)));
  const [first, ...rest] = shown;
  return first.toLocaleUpperCase("pt-BR") + rest.join("") + "***";
}

/** Lançamento já convertido para centavos (aposta negativa, prêmio/estorno positivos). */
export type FeedTx = {
  id: string;
  type: string;
  amountC: number;
  createdAt: Date;
  walletId: string;
  roundId?: string | null;
  gameId?: string | null;
  reference?: string | null;
};

export type WinCandidate = {
  key: string;            // estável: a mesma vitória mantém a mesma chave entre consultas
  txId: string;           // último prêmio da rodada (ou o próprio lançamento)
  walletId: string;
  product: "casino" | "sports";
  amountC: number;        // prêmio total pago
  stakeC: number | null;  // quanto foi apostado (null = desconhecido)
  at: Date;
  gameId: string | null;
  reference: string | null;
};

const opaque = (s: string) => crypto.createHash("sha256").update(s).digest("base64url").slice(0, 16);
const roundKeyOf = (t: FeedTx) => (t.roundId ? `${t.walletId}|${t.gameId ?? ""}|${t.roundId}` : null);

/**
 * Cassino: uma vitória por rodada. Soma todos os prêmios da rodada (rodada com giros grátis
 * paga em vários lançamentos) e calcula a aposta líquida (apostas − estornos) para o multiplicador.
 */
export function casinoCandidates(wins: FeedTx[], roundTxs: FeedTx[]): WinCandidate[] {
  const byRound = new Map<string, FeedTx[]>();
  for (const t of roundTxs) {
    const k = roundKeyOf(t);
    if (!k) continue;
    const list = byRound.get(k) ?? [];
    list.push(t);
    byRound.set(k, list);
  }
  const out = new Map<string, WinCandidate>();
  for (const w of wins) {
    const rk = roundKeyOf(w);
    if (!rk) {
      out.set(`tx:${w.id}`, {
        key: opaque(`tx:${w.id}`), txId: w.id, walletId: w.walletId, product: "casino",
        amountC: w.amountC, stakeC: null, at: w.createdAt, gameId: w.gameId ?? null, reference: w.reference ?? null,
      });
      continue;
    }
    if (out.has(rk)) continue;
    const txs = byRound.get(rk) ?? [w];
    let winC = 0, betC = 0, refundC = 0;
    let last = w;
    for (const t of txs) {
      if (t.type === "CASINO_WIN") {
        winC += t.amountC;
        if (t.createdAt > last.createdAt) last = t;
      } else if (t.type === "CASINO_BET") betC -= t.amountC;
      else if (t.type === "CASINO_REFUND") refundC += t.amountC;
    }
    const stakeC = betC - refundC;
    out.set(rk, {
      key: opaque(`round:${rk}`), txId: last.id, walletId: w.walletId, product: "casino",
      amountC: winC, stakeC: stakeC > 0 ? stakeC : null, at: last.createdAt, gameId: w.gameId ?? null, reference: w.reference ?? null,
    });
  }
  return [...out.values()];
}

/** Esportes: um bilhete ganho = uma vitória; a aposta vem do bilhete. */
export function sportsCandidates(wins: FeedTx[], stakeBySlip: Map<string, number>): WinCandidate[] {
  return wins.map((w) => {
    const slipId = w.reference?.startsWith("betslip:") ? w.reference.slice(8) : null;
    const stakeC = slipId ? stakeBySlip.get(slipId) ?? null : null;
    return {
      key: opaque(`tx:${w.id}`), txId: w.id, walletId: w.walletId, product: "sports" as const,
      amountC: w.amountC, stakeC: stakeC && stakeC > 0 ? stakeC : null, at: w.createdAt, gameId: null, reference: w.reference ?? null,
    };
  });
}

/** Fica só o que é vitória de verdade (pagou mais do que apostou) e passa do mínimo; mais recentes primeiro. */
export function selectWins(cands: WinCandidate[], cfg: Pick<WinsFeedConfig, "minAmount" | "limit">): WinCandidate[] {
  const minC = Math.round(cfg.minAmount * 100);
  return cands
    .filter((c) => c.amountC > 0 && c.amountC >= minC && (c.stakeC === null || c.amountC > c.stakeC))
    .sort((a, b) => b.at.getTime() - a.at.getTime() || (a.key < b.key ? -1 : 1))
    .slice(0, cfg.limit);
}

/** Prêmio ÷ aposta com 2 casas (multiplica antes de dividir: 55555/1000 dá 55,56, não 55,55). */
export const multiplierOf = (amountC: number, stakeC: number | null) =>
  stakeC ? Math.round((amountC * 100) / stakeC) / 100 : null;

/* ───────────────────────────── banco de dados ───────────────────────────── */

export type WinItem = {
  key: string;
  txId: string;
  userId: string;
  email: string;
  player: string;
  product: "casino" | "sports";
  title: string;
  detail: string | null;
  gameId: string | null;   // só quando o jogo está ativo (o card abre o jogo)
  imageUrl: string | null;
  amount: number;
  stake: number | null;
  multiplier: number | null;
  at: Date;
};

const toCents = (d: Prisma.Decimal | number | string) => Math.round(Number(d) * 100);
const uniq = <T,>(xs: T[]) => [...new Set(xs)];

const txSelect = {
  id: true, type: true, amount: true, createdAt: true, walletId: true, roundId: true, gameId: true, reference: true,
} as const;
type TxRow = { id: string; type: string; amount: Prisma.Decimal; createdAt: Date; walletId: string; roundId: string | null; gameId: string | null; reference: string | null };
const asTx = (r: TxRow): FeedTx =>
  ({ id: r.id, type: r.type, amountC: toCents(r.amount), createdAt: r.createdAt, walletId: r.walletId, roundId: r.roundId, gameId: r.gameId, reference: r.reference });
const eligiblePlayer = { user: { role: Role.PLAYER, isActive: true, isTest: false } }; // conta de teste não aparece na vitrine

/**
 * Rodadas de cassino cuja SOMA de prêmios passa do mínimo. Somar no banco importa: em giros
 * grátis/cascatas o agregador paga em vários lançamentos pequenos que, sozinhos, não passariam.
 */
function casinoRoundsOverMin(since: Date, min: Prisma.Decimal) {
  return prisma.walletTransaction.groupBy({
    by: ["walletId", "gameId", "roundId"],
    where: { type: "CASINO_WIN", roundId: { not: null }, createdAt: { gte: since }, wallet: eligiblePlayer },
    having: { amount: { _sum: { gte: min } } },
    orderBy: { _max: { createdAt: "desc" } },
    take: CANDIDATE_CAP,
  });
}

/** Prêmio sem rodada (cassino de agregador que não manda roundId) ou bilhete ganho: um lançamento = uma vitória. */
function singleWinsOverMin(type: "CASINO_WIN" | "BET_WIN", since: Date, min: Prisma.Decimal) {
  return prisma.walletTransaction.findMany({
    where: { type, ...(type === "CASINO_WIN" ? { roundId: null } : {}), createdAt: { gte: since }, amount: { gte: min }, wallet: eligiblePlayer },
    orderBy: { createdAt: "desc" },
    take: CANDIDATE_CAP,
    select: txSelect,
  });
}

export async function loadWins(cfg: WinsFeedConfig, now = new Date()): Promise<WinItem[]> {
  if (!cfg.casino && !cfg.sports) return [];
  const since = new Date(now.getTime() - cfg.maxAgeDays * DAY_MS);
  const min = new Prisma.Decimal(cfg.minAmount);

  const [rounds, casinoSingles, sportsRows] = await Promise.all([
    cfg.casino ? casinoRoundsOverMin(since, min) : Promise.resolve([]),
    cfg.casino ? singleWinsOverMin("CASINO_WIN", since, min) : Promise.resolve([]),
    cfg.sports ? singleWinsOverMin("BET_WIN", since, min) : Promise.resolve([]),
  ]);

  // Rodada inteira (apostas, prêmios e estornos) para o total exato e o multiplicador.
  const pairs = new Set(rounds.map((r) => `${r.walletId}|${r.roundId}`));
  const slipIds = uniq(sportsRows.map((r) => r.reference).filter((x): x is string => !!x?.startsWith("betslip:")).map((x) => x.slice(8)));
  const [roundTxs, slips] = await Promise.all([
    rounds.length
      ? prisma.walletTransaction
          .findMany({
            where: {
              type: { in: ["CASINO_BET", "CASINO_WIN", "CASINO_REFUND"] },
              walletId: { in: uniq(rounds.map((r) => r.walletId)) },
              roundId: { in: uniq(rounds.map((r) => r.roundId as string)) },
            },
            select: txSelect,
          })
          .then((txs) => txs.filter((t) => pairs.has(`${t.walletId}|${t.roundId}`)))
      : Promise.resolve([] as TxRow[]),
    slipIds.length
      ? prisma.betslip.findMany({
          where: { id: { in: slipIds } },
          select: { id: true, stake: true, type: true, selections: { select: { event: { select: { homeTeam: true, awayTeam: true } } } } },
        })
      : Promise.resolve([]),
  ]);

  const roundFeed = roundTxs.map(asTx);
  const picked = selectWins(
    [
      ...casinoCandidates([...roundFeed.filter((t) => t.type === "CASINO_WIN"), ...casinoSingles.map(asTx)], roundFeed),
      ...sportsCandidates(sportsRows.map(asTx), new Map(slips.map((s) => [s.id, toCents(s.stake)]))),
    ],
    cfg,
  );
  if (!picked.length) return [];

  // Nome e jogo só de quem vai aparecer.
  const gameIds = uniq(picked.map((c) => c.gameId).filter((x): x is string => !!x));
  const [wallets, games] = await Promise.all([
    prisma.wallet.findMany({
      where: { id: { in: uniq(picked.map((c) => c.walletId)) } },
      select: { id: true, userId: true, user: { select: { email: true, displayName: true } } },
    }),
    gameIds.length
      ? prisma.game.findMany({
          where: { id: { in: gameIds } },
          select: { id: true, name: true, imageUrl: true, isActive: true, provider: { select: { name: true } } },
        })
      : Promise.resolve([]),
  ]);
  const walletById = new Map(wallets.map((w) => [w.id, w]));
  const gameById = new Map(games.map((g) => [g.id, g]));
  const slipById = new Map(slips.map((s) => [s.id, s]));

  return picked.map((c) => {
    const w = walletById.get(c.walletId)!;
    let title = "Esportes", detail: string | null = null, gameId: string | null = null, imageUrl: string | null = null;
    if (c.product === "casino") {
      const g = c.gameId ? gameById.get(c.gameId) : undefined;
      title = g?.name ?? "Cassino";
      detail = g?.provider?.name ? providerDisplayName(g.provider.name) : null;
      gameId = g?.isActive ? g.id : null;
      imageUrl = g?.imageUrl ?? null;
    } else {
      const slip = c.reference ? slipById.get(c.reference.slice(8)) : undefined;
      if (slip?.type === "SINGLE" && slip.selections[0]) {
        detail = `${slip.selections[0].event.homeTeam} × ${slip.selections[0].event.awayTeam}`;
      } else if (slip) {
        detail = `Acumulada · ${slip.selections.length} seleções`;
      }
    }
    return {
      key: c.key,
      txId: c.txId,
      userId: w.userId,
      email: w.user.email,
      player: maskPlayer(w.user.displayName, w.user.email),
      product: c.product,
      title,
      detail,
      gameId,
      imageUrl,
      amount: c.amountC / 100,
      stake: c.stakeC === null ? null : c.stakeC / 100,
      multiplier: multiplierOf(c.amountC, c.stakeC),
      at: c.at,
    };
  });
}

/** O que sai na rota pública: nada que identifique o jogador (sem id, e-mail ou id de lançamento). */
export const toPublicWin = (w: WinItem) => ({
  key: w.key,
  player: w.player,
  product: w.product,
  title: w.title,
  detail: w.detail,
  gameId: w.gameId,
  imageUrl: w.imageUrl,
  amount: w.amount,
  multiplier: w.multiplier,
  at: w.at.toISOString(),
});

/** Prévia do admin: o mesmo card + quem é o jogador e quanto apostou. */
export const toAdminWin = (w: WinItem) => ({ ...toPublicWin(w), userId: w.userId, email: w.email, stake: w.stake });

/* ─────────────────────────────── ajustes ─────────────────────────────── */

export async function getWinsFeedConfig(): Promise<WinsFeedConfig> {
  const row = await prisma.siteSetting.findUnique({ where: { key: SETTING_KEY } });
  if (!row) return DEFAULT_WINS_FEED;
  try {
    const parsed = winsFeedConfigSchema.safeParse({ ...DEFAULT_WINS_FEED, ...JSON.parse(row.value) });
    return parsed.success ? parsed.data : DEFAULT_WINS_FEED;
  } catch {
    return DEFAULT_WINS_FEED;
  }
}

/** Salva e registra na auditoria na mesma transação. */
export async function saveWinsFeedConfig(cfg: WinsFeedConfig, adminId: string) {
  const before = await getWinsFeedConfig();
  const value = JSON.stringify(cfg);
  await prisma.$transaction([
    prisma.siteSetting.upsert({ where: { key: SETTING_KEY }, create: { key: SETTING_KEY, value }, update: { value } }),
    prisma.adminAuditLog.create({
      data: { adminId, action: "WINS_FEED_UPDATE", target: SETTING_KEY, payload: JSON.stringify({ before, after: cfg }) },
    }),
  ]);
  invalidateWinsFeed();
}

/* ──────────────────────── vitrine pública com cache ──────────────────────── */

type PublicFeed = { enabled: boolean; items: ReturnType<typeof toPublicWin>[] };
let generation = 0;
let cached: { gen: number; exp: number; data: PublicFeed } | null = null;
let inflight: { gen: number; p: Promise<PublicFeed> } | null = null;

async function buildPublicFeed(): Promise<PublicFeed> {
  const cfg = await getWinsFeedConfig();
  if (!cfg.enabled) return { enabled: false, items: [] };
  return { enabled: true, items: (await loadWins(cfg)).map(toPublicWin) };
}

/** Uma consulta por janela de 10 s, por mais visitantes que estejam na página. */
export function publicWinsFeed(): Promise<PublicFeed> {
  if (cached && cached.gen === generation && cached.exp > Date.now()) return Promise.resolve(cached.data);
  if (inflight && inflight.gen === generation) return inflight.p;
  const gen = generation;
  const p = buildPublicFeed()
    .then((data) => {
      if (gen === generation) cached = { gen, exp: Date.now() + CACHE_MS, data };
      return data;
    })
    .finally(() => {
      if (inflight?.p === p) inflight = null;
    });
  inflight = { gen, p };
  return p;
}

/** Depois de salvar os ajustes: a próxima visita já vê a regra nova. */
export function invalidateWinsFeed() {
  generation++;
  cached = null;
}
