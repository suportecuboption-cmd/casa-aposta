import { prisma } from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";

/**
 * Relatórios financeiros a partir do razão da carteira (WalletTransaction), base caixa:
 *   turnover (apostas líquidas) = apostas − devoluções/estornos
 *   GGR = turnover − prêmios        RTP = prêmios ÷ turnover        NGR = GGR − bônus
 * Valores somados em centavos inteiros; dias no fuso de São Paulo.
 */

export const TZ = "America/Sao_Paulo";
const TZ_OFFSET = "-03:00"; // Brasil sem horário de verão desde 2019
const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
export const dayKey = (d: Date) => dayFmt.format(d); // "2026-11-21"

/* ───────────── período ───────────── */

export interface Period {
  from: string; // YYYY-MM-DD (São Paulo)
  to: string; // inclusive
  start: Date; // instante inicial (inclusive)
  end: Date; // instante final (exclusivo)
  days: string[];
}

const addDays = (ymd: string, n: number) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export function makePeriod(from?: string, to?: string, now = new Date()): Period {
  const today = dayKey(now);
  const t = to ?? today;
  const f = from ?? addDays(t, -6); // padrão: últimos 7 dias
  if (f > t) throw new AppError("A data inicial deve ser antes da final", 400, "BAD_PERIOD");
  const days: string[] = [];
  for (let d = f; d <= t; d = addDays(d, 1)) {
    days.push(d);
    if (days.length > 366) throw new AppError("Período máximo de 1 ano", 400, "BAD_PERIOD");
  }
  return { from: f, to: t, days, start: new Date(`${f}T00:00:00${TZ_OFFSET}`), end: new Date(`${addDays(t, 1)}T00:00:00${TZ_OFFSET}`) };
}

/** Período imediatamente anterior, com a mesma quantidade de dias (para comparar). */
export const previousPeriod = (p: Period) => makePeriod(addDays(p.from, -p.days.length), addDays(p.from, -1));

/* ───────────── agregação pura (testável) ───────────── */

export interface LedgerRow {
  type: string;
  amount: number; // como gravado: aposta negativa, prêmio positivo
  createdAt: Date;
  userId: string;
  gameId?: string | null;
}

const BUCKET_KEYS = [
  "deposits", "withdrawals", "sportsStake", "sportsWin", "sportsRefund",
  "casinoStake", "casinoWin", "casinoRefund", "bonus", "adjustments",
] as const;
type Bucket = Record<(typeof BUCKET_KEYS)[number], number>; // centavos
const emptyBucket = (): Bucket => Object.fromEntries(BUCKET_KEYS.map((k) => [k, 0])) as Bucket;

const cents = (v: number) => Math.round(v * 100);
const reais = (c: number) => c / 100;

function addRow(b: Bucket, r: LedgerRow) {
  const c = cents(r.amount);
  switch (r.type) {
    case "DEPOSIT": b.deposits += c; break;
    case "WITHDRAW": b.withdrawals -= c; break;
    case "BET_STAKE": b.sportsStake -= c; break;
    case "BET_WIN": b.sportsWin += c; break;
    case "BET_REFUND": b.sportsRefund += c; break;
    case "CASINO_BET": b.casinoStake -= c; break;
    case "CASINO_WIN": b.casinoWin += c; break;
    case "CASINO_REFUND": b.casinoRefund += c; break;
    case "BONUS": b.bonus += c; break;
    case "ADJUSTMENT": b.adjustments += c; break;
  }
}

/** Indicadores de um produto a partir de apostas, devoluções e prêmios (centavos → reais). */
export function productMetrics(stakeC: number, refundC: number, winC: number) {
  const turnover = stakeC - refundC;
  const ggr = turnover - winC;
  return {
    stake: reais(stakeC),
    refunds: reais(refundC),
    turnover: reais(turnover),
    wins: reais(winC),
    ggr: reais(ggr),
    rtp: turnover > 0 ? winC / turnover : null, // fração (0.96 = 96%)
  };
}

export function bucketMetrics(b: Bucket) {
  const sports = productMetrics(b.sportsStake, b.sportsRefund, b.sportsWin);
  const casino = productMetrics(b.casinoStake, b.casinoRefund, b.casinoWin);
  const turnover = b.sportsStake - b.sportsRefund + b.casinoStake - b.casinoRefund;
  const wins = b.sportsWin + b.casinoWin;
  const ggr = turnover - wins;
  return {
    deposits: reais(b.deposits),
    withdrawals: reais(b.withdrawals),
    netDeposits: reais(b.deposits - b.withdrawals),
    bonus: reais(b.bonus),
    adjustments: reais(b.adjustments),
    sports,
    casino,
    total: { turnover: reais(turnover), wins: reais(wins), ggr: reais(ggr), rtp: turnover > 0 ? wins / turnover : null, ngr: reais(ggr - b.bonus) },
  };
}

export function summarizeLedger(rows: LedgerRow[], days: string[]) {
  const total = emptyBucket();
  const byDay = new Map(days.map((d) => [d, emptyBucket()]));
  const counts = { deposits: 0, withdrawals: 0, sportsBets: 0, casinoRounds: 0 };
  const active = new Set<string>();
  const depositors = new Set<string>();
  for (const r of rows) {
    addRow(total, r);
    const day = byDay.get(dayKey(r.createdAt));
    if (day) addRow(day, r);
    if (r.type === "DEPOSIT") { counts.deposits++; depositors.add(r.userId); }
    if (r.type === "WITHDRAW") counts.withdrawals++;
    if (r.type === "BET_STAKE") { counts.sportsBets++; active.add(r.userId); }
    if (r.type === "CASINO_BET") { counts.casinoRounds++; active.add(r.userId); }
  }
  return {
    ...bucketMetrics(total),
    counts,
    activePlayers: active.size,
    depositors: depositors.size,
    daily: days.map((d) => {
      const m = bucketMetrics(byDay.get(d)!);
      return {
        date: d,
        deposits: m.deposits,
        withdrawals: m.withdrawals,
        turnover: m.total.turnover,
        wins: m.total.wins,
        ggr: m.total.ggr,
        sportsGgr: m.sports.ggr,
        casinoGgr: m.casino.ggr,
      };
    }),
  };
}

/** Por jogo: apostas, prêmios, GGR, RTP, rodadas e jogadores distintos. */
export function summarizeByGame(rows: LedgerRow[]) {
  const map = new Map<string, { stake: number; win: number; refund: number; rounds: number; players: Set<string> }>();
  for (const r of rows) {
    if (!r.gameId) continue;
    const g = map.get(r.gameId) ?? { stake: 0, win: 0, refund: 0, rounds: 0, players: new Set<string>() };
    const c = cents(r.amount);
    if (r.type === "CASINO_BET") { g.stake -= c; g.rounds++; g.players.add(r.userId); }
    if (r.type === "CASINO_WIN") g.win += c;
    if (r.type === "CASINO_REFUND") g.refund += c;
    map.set(r.gameId, g);
  }
  return [...map].map(([gameId, g]) => ({
    gameId,
    rounds: g.rounds,
    players: g.players.size,
    ...productMetrics(g.stake, g.refund, g.win),
  }));
}

/* ───────────── consultas ───────────── */

const PLAYER = { wallet: { user: { role: "PLAYER" as const } } };

async function ledgerRows(p: Period, types?: string[]): Promise<LedgerRow[]> {
  const rows = await prisma.walletTransaction.findMany({
    where: {
      createdAt: { gte: p.start, lt: p.end },
      ...PLAYER,
      ...(types ? { type: { in: types as never[] } } : {}),
    },
    select: { type: true, amount: true, createdAt: true, gameId: true, wallet: { select: { userId: true } } },
  });
  return rows.map((r) => ({ type: r.type, amount: Number(r.amount), createdAt: r.createdAt, gameId: r.gameId, userId: r.wallet.userId }));
}

export async function summaryReport(p: Period) {
  const prev = previousPeriod(p);
  const [rows, prevRows, newPlayers, prevNewPlayers, firstDeposits] = await Promise.all([
    ledgerRows(p),
    ledgerRows(prev),
    prisma.user.count({ where: { role: "PLAYER", createdAt: { gte: p.start, lt: p.end } } }),
    prisma.user.count({ where: { role: "PLAYER", createdAt: { gte: prev.start, lt: prev.end } } }),
    prisma.walletTransaction.groupBy({ by: ["walletId"], where: { type: "DEPOSIT", ...PLAYER }, _min: { createdAt: true } }),
  ]);
  const cur = summarizeLedger(rows, p.days);
  const before = summarizeLedger(prevRows, prev.days);

  // FTD: jogadores cujo primeiro depósito da vida caiu no período.
  const ftdWallets = firstDeposits
    .filter((f) => f._min.createdAt && f._min.createdAt >= p.start && f._min.createdAt < p.end)
    .map((f) => ({ walletId: f.walletId, at: f._min.createdAt! }));
  const ftdTxs = ftdWallets.length
    ? await prisma.walletTransaction.findMany({
        where: { type: "DEPOSIT", OR: ftdWallets.map((f) => ({ walletId: f.walletId, createdAt: f.at })) },
        select: { walletId: true, amount: true },
      })
    : [];
  const ftdAmount = [...new Map(ftdTxs.map((t) => [t.walletId, Number(t.amount)])).values()].reduce((s, v) => s + v, 0);

  const [balances, openBets, pending] = await Promise.all([
    prisma.wallet.aggregate({ where: { user: { role: "PLAYER" } }, _sum: { balance: true } }),
    prisma.betslip.aggregate({ where: { status: "OPEN" }, _sum: { stake: true, potentialReturn: true }, _count: { _all: true } }),
    prisma.pixOrder.groupBy({ by: ["kind"], where: { status: "PENDING" }, _sum: { amount: true }, _count: { _all: true } }),
  ]);
  const pend = (kind: string) => {
    const g = pending.find((x) => x.kind === kind);
    return { count: g?._count._all ?? 0, amount: Number(g?._sum.amount ?? 0) };
  };

  const { daily, counts, activePlayers, depositors, ...totals } = cur;
  const { daily: _d, counts: prevCounts, activePlayers: prevActive, depositors: prevDepositors, ...prevTotals } = before;
  return {
    period: { from: p.from, to: p.to, days: p.days.length, timezone: TZ },
    totals,
    counts,
    players: {
      new: newPlayers,
      active: activePlayers,
      depositors,
      ftd: ftdWallets.length,
      ftdAmount: Math.round(ftdAmount * 100) / 100,
      avgDeposit: counts.deposits ? Math.round((totals.deposits / counts.deposits) * 100) / 100 : 0,
    },
    previous: {
      period: { from: prev.from, to: prev.to },
      totals: prevTotals,
      counts: prevCounts,
      players: { new: prevNewPlayers, active: prevActive, depositors: prevDepositors },
    },
    daily,
    liabilities: {
      walletBalances: Number(balances._sum.balance ?? 0),
      openBets: {
        count: openBets._count._all,
        stake: Number(openBets._sum.stake ?? 0),
        maxPayout: Number(openBets._sum.potentialReturn ?? 0),
      },
      pendingDeposits: pend("DEPOSIT"),
      pendingWithdrawals: pend("WITHDRAW"),
    },
  };
}

export async function casinoReport(p: Period) {
  const rows = await ledgerRows(p, ["CASINO_BET", "CASINO_WIN", "CASINO_REFUND"]);
  const perGame = summarizeByGame(rows);
  const games = await prisma.game.findMany({
    where: { id: { in: perGame.map((g) => g.gameId) } },
    include: { provider: true },
  });
  const byId = new Map(games.map((g) => [g.id, g]));
  const gameRows = perGame
    .map((g) => {
      const meta = byId.get(g.gameId);
      return { ...g, name: meta?.name ?? "(jogo removido)", provider: meta?.provider.name ?? "—", providerSlug: meta?.provider.slug ?? null };
    })
    .sort((a, b) => b.turnover - a.turnover);

  const provMap = new Map<string, { name: string; stake: number; refund: number; win: number; rounds: number; players: Set<string>; games: number }>();
  for (const g of gameRows) {
    const key = g.providerSlug ?? g.provider;
    const v = provMap.get(key) ?? { name: g.provider, stake: 0, refund: 0, win: 0, rounds: 0, players: new Set<string>(), games: 0 };
    v.stake += cents(g.stake); v.refund += cents(g.refunds); v.win += cents(g.wins); v.rounds += g.rounds; v.games++;
    provMap.set(key, v);
  }
  // jogadores distintos por provedor (um jogador pode jogar vários jogos do mesmo provedor)
  for (const r of rows) {
    if (r.type !== "CASINO_BET" || !r.gameId) continue;
    const meta = byId.get(r.gameId);
    const key = meta?.provider.slug ?? meta?.provider.name;
    if (key) provMap.get(key)?.players.add(r.userId);
  }
  const providers = [...provMap].map(([slug, v]) => ({
    slug, name: v.name, games: v.games, rounds: v.rounds, players: v.players.size, ...productMetrics(v.stake, v.refund, v.win),
  })).sort((a, b) => b.turnover - a.turnover);

  return { period: { from: p.from, to: p.to }, games: gameRows, providers };
}

export async function sportsReport(p: Period) {
  const [byStatus, byType] = await Promise.all([
    prisma.betslip.groupBy({ by: ["status"], where: { createdAt: { gte: p.start, lt: p.end } }, _count: { _all: true }, _sum: { stake: true, payout: true } }),
    prisma.betslip.groupBy({ by: ["type"], where: { createdAt: { gte: p.start, lt: p.end } }, _count: { _all: true }, _sum: { stake: true } }),
  ]);
  return {
    period: { from: p.from, to: p.to },
    byStatus: byStatus.map((s) => ({ status: s.status, count: s._count._all, stake: Number(s._sum.stake ?? 0), payout: Number(s._sum.payout ?? 0) })),
    byType: byType.map((t) => ({ type: t.type, count: t._count._all, stake: Number(t._sum.stake ?? 0) })),
  };
}
