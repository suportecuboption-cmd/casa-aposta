import type { Decimal } from "@prisma/client/runtime/library";
import type { WalletTxType } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";
import { TZ, dayKey } from "./reports.js";
import { dashboardParamsSchema, type DashboardParams, type DashQuery } from "../schemas/dashboard.js";
import { playfiversAdapter } from "../casino/adapters/playfivers.js";

/**
 * Dashboard no modelo do Axio Backoffice: mesmas definições, fórmulas e regras de período do
 * guia (seção 8 — "Base de cálculo de todos os parâmetros"). Valores em centavos inteiros até a
 * exibição. Só contas de jogador entram (equipe fica de fora).
 *
 *   Turnover = Σ apostas · Payout = Wins + Refunds · GGR = Turnover − Payout
 *   Hold = GGR ÷ Turnover · RTP = Payout ÷ Turnover · divisão por zero = 0
 */

const OFFSET = "-03:00"; // Brasil sem horário de verão desde 2019
const DAY_MS = 86_400_000;
const addDays = (ymd: string, n: number) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const cents = (v: Decimal | number | null | undefined) => Math.round(Number(v ?? 0) * 100);

/* ───────────────────────────── período ───────────────────────────── */

export interface DashPeriod {
  from: string;
  to: string;
  start: Date;
  end: Date; // exclusivo
  prevStart: Date;
  prevEnd: Date;
  live: boolean; // inclui hoje → termina no momento atual
}

/**
 * Regras do guia (8.1): fuso de São Paulo; começa às 00:00 do dia inicial; se o período inclui
 * hoje, termina AGORA (não às 23:59); o anterior tem a MESMA DURAÇÃO, imediatamente antes.
 */
export function dashPeriod(from?: string, to?: string, now = new Date()): DashPeriod {
  const t = to ?? dayKey(now);
  const f = from ?? t; // padrão: hoje, como no painel
  if (f > t) throw new AppError("A data inicial deve ser antes da final", 400, "BAD_PERIOD");
  const start = new Date(`${f}T00:00:00${OFFSET}`);
  const dayEnd = new Date(`${addDays(t, 1)}T00:00:00${OFFSET}`);
  if (dayEnd.getTime() - start.getTime() > 366 * DAY_MS) throw new AppError("Período máximo de 1 ano", 400, "BAD_PERIOD");
  const live = dayEnd > now;
  const end = live ? now : dayEnd;
  if (end <= start) throw new AppError("O período começa no futuro", 400, "BAD_PERIOD");
  const dur = end.getTime() - start.getTime();
  return { from: f, to: t, start, end, prevStart: new Date(start.getTime() - dur), prevEnd: start, live };
}

/* ───────────────────────────── moeda ───────────────────────────── */

export type Cur = "BRL" | "USD";
export interface Ctx {
  mode: "native" | "usd";
  cur: Cur;
  rate: number | null; // R$ por US$ 1
}

/** Centavos de `from` para a moeda do contexto; null se faltar cotação. */
export function convertC(c: number, from: string, ctx: Ctx): number | null {
  if (from === ctx.cur) return c;
  if (!ctx.rate) return null;
  if (from === "BRL" && ctx.cur === "USD") return Math.round(c / ctx.rate);
  if (from === "USD" && ctx.cur === "BRL") return Math.round(c * ctx.rate);
  return null;
}

/** Nativa: só a moeda escolhida. USD Geral: todas (convertidas). */
export const inScope = (currency: string, ctx: Ctx) => ctx.mode === "usd" || currency === ctx.cur;

/** Falta de cotação só é erro quando algum valor precisa ser convertido. */
function ensureRate(ctx: Ctx, currencies: Iterable<string>) {
  if (ctx.mode !== "usd" || ctx.rate) return;
  for (const c of currencies) {
    if (c !== ctx.cur) throw new AppError("Defina a cotação do dólar em Ajustes → Parâmetros para ver os valores convertidos.", 409, "FX_MISSING");
  }
}

/* ───────────────────────── fórmulas (puras, testadas) ───────────────────────── */

/** Divisão do guia: denominador zero mostra 0. */
export const ratio = (a: number, b: number) => (b ? a / b : 0);

export interface MoneyRow {
  type: string;
  c: number; // centavos na moeda do contexto, sinal como gravado (aposta negativa)
  userId: string;
  gameId?: string | null;
}

const PLAY_TYPES = {
  casino: ["CASINO_BET", "CASINO_WIN", "CASINO_REFUND"],
  sports: ["BET_STAKE", "BET_WIN", "BET_REFUND"],
} as const;

/** Resultado de jogo (cassino ou esportes) a partir dos lançamentos do extrato. */
export function playMetrics(rows: MoneyRow[], product: "casino" | "sports") {
  const [BET, WIN, REFUND] = PLAY_TYPES[product];
  let bets = 0, winsCount = 0, stakeC = 0, winC = 0, refundC = 0;
  const players = new Set<string>();
  for (const r of rows) {
    if (r.type === BET) { bets++; stakeC -= r.c; players.add(r.userId); }
    else if (r.type === WIN) { winC += r.c; if (r.c > 0) winsCount++; }
    else if (r.type === REFUND) refundC += r.c;
  }
  const payoutC = winC + refundC;
  const ggrC = stakeC - payoutC;
  return {
    metrics: {
      bets,
      winsCount,
      players: players.size,
      turnover: stakeC / 100,
      wins: winC / 100,
      refunds: refundC / 100,
      payout: payoutC / 100,
      ggr: ggrC / 100,
      hold: ratio(ggrC, stakeC),
      rtp: ratio(payoutC, stakeC),
      avgBet: ratio(stakeC, bets) / 100,
    },
    ggrC,
    stakeC,
    playerIds: players,
  };
}

export interface PixRow {
  id: string;
  kind: string; // DEPOSIT | WITHDRAW
  status: string; // PENDING | PAID | FAILED | EXPIRED
  c: number; // valor (centavos, moeda do contexto)
  feeC: number;
  userId: string;
  createdAt: Date;
  paidAt: Date | null;
}
export interface FirstDeposit {
  id: string;
  at: Date;
  netC: number;
}

const inWindow = (d: Date | null, start: Date, end: Date) => !!d && d >= start && d < end;

function paySide(rows: PixRow[], kind: string, start: Date, end: Date) {
  // Solicitados: pedidos criados no período (qualquer status). Completados: pagos no período.
  const requested = rows.filter((r) => r.kind === kind && inWindow(r.createdAt, start, end)).length;
  const done = rows.filter((r) => r.kind === kind && r.status === "PAID" && inWindow(r.paidAt, start, end));
  let netC = 0, feeC = 0;
  const users = new Set<string>();
  for (const r of done) { netC += r.c - r.feeC; feeC += r.feeC; users.add(r.userId); }
  return { requested, done, netC, feeC, users };
}

/** Depósitos, saques, FTD e retenção (guia 8.4–8.7). `firsts`: 1º depósito pago da VIDA de cada jogador. */
export function paymentMetrics(rows: PixRow[], start: Date, end: Date, firsts: Map<string, FirstDeposit>, signups: number) {
  const d = paySide(rows, "DEPOSIT", start, end);
  const w = paySide(rows, "WITHDRAW", start, end);
  let ftds = 0, ftdNetC = 0;
  for (const f of firsts.values()) {
    if (inWindow(f.at, start, end)) { ftds++; ftdNetC += f.netC; }
  }
  // Redepositantes: depositaram no período algo que não é o primeiro depósito da vida.
  const redep = new Set(d.done.filter((o) => firsts.get(o.userId)?.id !== o.id).map((o) => o.userId));
  const side = (s: ReturnType<typeof paySide>) => ({
    requested: s.requested,
    completed: s.done.length,
    net: s.netC / 100,
    fee: s.feeC / 100,
    avgTicket: ratio(s.netC, s.done.length) / 100,
    unique: s.users.size,
  });
  return {
    metrics: {
      deposits: side(d),
      withdrawals: side(w),
      ftd: {
        count: ftds,
        net: ftdNetC / 100,
        avgTicket: ratio(ftdNetC, ftds) / 100,
        share: ratio(ftds, d.users.size),
        redepositors: redep.size,
        conversion: ratio(ftds, signups),
        perDepositor: ratio(d.done.length, d.users.size),
      },
      netCashflow: (d.netC - w.netC) / 100,
      withdrawDeposit: ratio(w.netC, d.netC),
    },
    depositNetC: d.netC,
    depositorIds: d.users,
  };
}

/** Jogadores e monetização (guia 8.3): ARPU, ARPPU e GGR por player dividem o GGR por bases diferentes. */
export function userMetrics(ggrC: number, players: number, payingActive: number, active: number, signups: number) {
  return {
    signups,
    active,
    payingActive,
    players,
    arpu: ratio(ggrC, active) / 100,
    arppu: ratio(ggrC, payingActive) / 100,
    ggrPerPlayer: ratio(ggrC, players) / 100,
  };
}

/** Indicadores de um intervalo (atual ou anterior). */
export function windowMetrics(
  ledger: (MoneyRow & { at: Date })[],
  pix: PixRow[],
  firsts: Map<string, FirstDeposit>,
  start: Date,
  end: Date,
  active: number,
  signups: number,
) {
  const rows = ledger.filter((r) => inWindow(r.at, start, end));
  const casino = playMetrics(rows, "casino");
  const sports = playMetrics(rows, "sports");
  const pay = paymentMetrics(pix, start, end, firsts, signups);
  // Pagantes ativos: depositaram OU apostaram com dinheiro real (cassino ou esportes).
  const paying = new Set([...pay.depositorIds, ...casino.playerIds, ...sports.playerIds]);
  return {
    casino: casino.metrics,
    payments: pay.metrics,
    users: userMetrics(casino.ggrC, casino.metrics.players, paying.size, active, signups),
  };
}

/* ───────────────────────────── consultas ───────────────────────────── */

const ALL_PLAY: WalletTxType[] = ["CASINO_BET", "CASINO_WIN", "CASINO_REFUND", "BET_STAKE", "BET_WIN", "BET_REFUND"];
const CASINO_ONLY: WalletTxType[] = ["CASINO_BET", "CASINO_WIN", "CASINO_REFUND"];

interface LedgerRaw { type: string; nc: number; currency: string; userId: string; gameId: string | null; at: Date }
interface PixRaw { id: string; kind: string; status: string; nc: number; nfee: number; currency: string; userId: string; createdAt: Date; paidAt: Date | null }

async function loadLedger(start: Date, end: Date, types: WalletTxType[]): Promise<LedgerRaw[]> {
  const rows = await prisma.walletTransaction.findMany({
    where: { createdAt: { gte: start, lt: end }, type: { in: types }, wallet: { user: { role: "PLAYER", isTest: false } } },
    select: { type: true, amount: true, createdAt: true, gameId: true, wallet: { select: { userId: true, currency: true } } },
  });
  return rows.map((r) => ({ type: r.type, nc: cents(r.amount), currency: r.wallet.currency, userId: r.wallet.userId, gameId: r.gameId, at: r.createdAt }));
}

async function loadPix(start: Date, end: Date): Promise<PixRaw[]> {
  const rows = await prisma.pixOrder.findMany({
    where: { user: { role: "PLAYER", isTest: false }, OR: [{ createdAt: { gte: start, lt: end } }, { paidAt: { gte: start, lt: end } }] },
    select: { id: true, kind: true, status: true, amount: true, fee: true, createdAt: true, paidAt: true, userId: true, user: { select: { wallet: { select: { currency: true } } } } },
  });
  return rows.map((r) => ({
    id: r.id, kind: r.kind, status: r.status, nc: cents(r.amount), nfee: cents(r.fee),
    currency: r.user.wallet?.currency ?? "BRL", userId: r.userId, createdAt: r.createdAt, paidAt: r.paidAt,
  }));
}

/** 1º depósito pago da vida de cada jogador (só de quem depositou nos intervalos analisados). */
async function loadFirstDeposits(userIds: string[]) {
  const out = new Map<string, { id: string; at: Date; nc: number; nfee: number; currency: string }>();
  if (!userIds.length) return out;
  const mins = await prisma.pixOrder.groupBy({
    by: ["userId"],
    where: { kind: "DEPOSIT", status: "PAID", userId: { in: userIds } },
    _min: { paidAt: true },
  });
  const pairs = mins.filter((m) => m._min.paidAt).map((m) => ({ userId: m.userId, paidAt: m._min.paidAt! }));
  if (!pairs.length) return out;
  const rows = await prisma.pixOrder.findMany({
    where: { kind: "DEPOSIT", status: "PAID", OR: pairs },
    select: { id: true, userId: true, paidAt: true, amount: true, fee: true, user: { select: { wallet: { select: { currency: true } } } } },
    orderBy: [{ paidAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });
  for (const r of rows) {
    if (!out.has(r.userId)) {
      out.set(r.userId, { id: r.id, at: r.paidAt!, nc: cents(r.amount), nfee: cents(r.fee), currency: r.user.wallet?.currency ?? "BRL" });
    }
  }
  return out;
}

const userScope = (ctx: Ctx) => (ctx.mode === "native" ? { wallet: { is: { currency: ctx.cur } } } : {});

async function countActive(start: Date, end: Date, ctx: Ctx) {
  const rows = await prisma.userActivity.groupBy({
    by: ["userId"],
    where: { at: { gte: start, lt: end }, user: { role: "PLAYER", isTest: false, ...userScope(ctx) } },
  });
  return rows.length;
}

const countSignups = (start: Date, end: Date, ctx: Ctx) =>
  prisma.user.count({ where: { role: "PLAYER", isTest: false, createdAt: { gte: start, lt: end }, ...userScope(ctx) } });

/** Saldo das carteiras AGORA, por moeda (não depende do período — guia 8.1). */
async function loadWallets() {
  const [act, inact] = await Promise.all([
    prisma.wallet.groupBy({ by: ["currency"], where: { user: { role: "PLAYER", isTest: false, isActive: true } }, _sum: { balance: true, bonus: true } }),
    prisma.wallet.groupBy({ by: ["currency"], where: { user: { role: "PLAYER", isTest: false, isActive: false } }, _sum: { balance: true, bonus: true } }),
  ]);
  const map = new Map<string, { availC: number; blockedC: number }>();
  const entry = (cur: string) => map.get(cur) ?? map.set(cur, { availC: 0, blockedC: 0 }).get(cur)!;
  // Disponível: saldo de contas ativas. Bloqueado: bônus (não sacável) + saldo de contas bloqueadas.
  for (const g of act) { const e = entry(g.currency); e.availC += cents(g._sum.balance); e.blockedC += cents(g._sum.bonus); }
  for (const g of inact) { const e = entry(g.currency); e.blockedC += cents(g._sum.balance) + cents(g._sum.bonus); }
  return map;
}

/* ───────────────────────────── parâmetros ───────────────────────────── */

const PARAMS_KEY = "dashboard";
export const DEFAULT_DASHBOARD_PARAMS: DashboardParams = { usdBrlRate: null, panelUrl: "", wallets: {} };
export const DEFAULT_MIN_BALANCE = 100;

export async function getDashboardParams(): Promise<DashboardParams> {
  const row = await prisma.siteSetting.findUnique({ where: { key: PARAMS_KEY } });
  if (!row) return DEFAULT_DASHBOARD_PARAMS;
  try {
    const parsed = dashboardParamsSchema.safeParse({ ...DEFAULT_DASHBOARD_PARAMS, ...JSON.parse(row.value) });
    return parsed.success ? parsed.data : DEFAULT_DASHBOARD_PARAMS;
  } catch {
    return DEFAULT_DASHBOARD_PARAMS;
  }
}

/** Salva e registra na auditoria na mesma transação. */
export async function saveDashboardParams(params: DashboardParams, adminId: string) {
  const before = await getDashboardParams();
  const value = JSON.stringify(params);
  await prisma.$transaction([
    prisma.siteSetting.upsert({ where: { key: PARAMS_KEY }, create: { key: PARAMS_KEY, value }, update: { value } }),
    prisma.adminAuditLog.create({
      data: { adminId, action: "DASHBOARD_PARAMS_UPDATE", target: PARAMS_KEY, payload: JSON.stringify({ before, after: params }) },
    }),
  ]);
  return params;
}

/* ───────────────────────────── relatórios ───────────────────────────── */

const periodOut = (p: DashPeriod) => ({
  from: p.from, to: p.to, live: p.live, timezone: TZ,
  start: p.start.toISOString(), end: p.end.toISOString(),
  prevStart: p.prevStart.toISOString(), prevEnd: p.prevEnd.toISOString(),
});

function scopeLedger(raw: LedgerRaw[], ctx: Ctx) {
  return raw.filter((r) => inScope(r.currency, ctx)).map((r) => ({ type: r.type, c: convertC(r.nc, r.currency, ctx)!, userId: r.userId, gameId: r.gameId, at: r.at }));
}
function scopePix(raw: PixRaw[], ctx: Ctx): PixRow[] {
  return raw.filter((r) => inScope(r.currency, ctx)).map((r) => ({
    id: r.id, kind: r.kind, status: r.status, c: convertC(r.nc, r.currency, ctx)!, feeC: convertC(r.nfee, r.currency, ctx)!,
    userId: r.userId, createdAt: r.createdAt, paidAt: r.paidAt,
  }));
}

/** Abas Visão Geral, Pagamentos, Carteira & Moedas e Cassino & Jogadores. */
export async function dashboardSummary(p: DashPeriod, q: Pick<DashQuery, "mode" | "cur">) {
  const params = await getDashboardParams();
  const ctx: Ctx = { mode: q.mode, cur: q.cur, rate: params.usdBrlRate };
  const [ledgerRaw, pixRaw, wallets] = await Promise.all([loadLedger(p.prevStart, p.end, ALL_PLAY), loadPix(p.prevStart, p.end), loadWallets()]);
  ensureRate(ctx, [...ledgerRaw.map((r) => r.currency), ...pixRaw.map((r) => r.currency), ...wallets.keys()]);

  const depositors = [...new Set(pixRaw.filter((r) => r.kind === "DEPOSIT" && r.status === "PAID").map((r) => r.userId))];
  const [firstsRaw, active, prevActive, signups, prevSignups] = await Promise.all([
    loadFirstDeposits(depositors),
    countActive(p.start, p.end, ctx),
    countActive(p.prevStart, p.prevEnd, ctx),
    countSignups(p.start, p.end, ctx),
    countSignups(p.prevStart, p.prevEnd, ctx),
  ]);
  const firsts = new Map<string, FirstDeposit>();
  for (const [u, f] of firstsRaw) {
    if (inScope(f.currency, ctx)) firsts.set(u, { id: f.id, at: f.at, netC: convertC(f.nc - f.nfee, f.currency, ctx)! });
  }

  const ledger = scopeLedger(ledgerRaw, ctx);
  const pix = scopePix(pixRaw, ctx);
  const current = windowMetrics(ledger, pix, firsts, p.start, p.end, active, signups);
  const previous = windowMetrics(ledger, pix, firsts, p.prevStart, p.prevEnd, prevActive, prevSignups);

  // Carteira (agora) no contexto escolhido.
  let availC = 0, blockedC = 0;
  for (const [cur, w] of wallets) {
    if (!inScope(cur, ctx)) continue;
    availC += convertC(w.availC, cur, ctx)!;
    blockedC += convertC(w.blockedC, cur, ctx)!;
  }

  // Tabelas por moeda de origem (sem conversão), período atual.
  const currencies = [...new Set([...ledgerRaw.map((r) => r.currency), ...pixRaw.map((r) => r.currency), ...wallets.keys()])].sort();
  if (!currencies.length) currencies.push("BRL");
  const byCurrency = currencies.map((cur) => {
    const nat: Ctx = { mode: "native", cur: cur as Cur, rate: ctx.rate };
    const L = scopeLedger(ledgerRaw, nat).filter((r) => inWindow(r.at, p.start, p.end));
    const pay = paymentMetrics(scopePix(pixRaw, nat), p.start, p.end, new Map(), 0).metrics;
    const cas = playMetrics(L, "casino").metrics;
    const w = wallets.get(cur) ?? { availC: 0, blockedC: 0 };
    const totalC = w.availC + w.blockedC;
    const usdC = cur === "USD" ? totalC : ctx.rate && cur === "BRL" ? Math.round(totalC / ctx.rate) : null;
    return {
      currency: cur,
      deposits: { requested: pay.deposits.requested, completed: pay.deposits.completed, net: pay.deposits.net, fee: pay.deposits.fee },
      withdrawals: { requested: pay.withdrawals.requested, completed: pay.withdrawals.completed, net: pay.withdrawals.net, fee: pay.withdrawals.fee },
      wallet: { available: w.availC / 100, blocked: w.blockedC / 100, totalLocal: totalC / 100, totalUsd: usdC == null ? null : usdC / 100 },
      casino: { bets: cas.bets, players: cas.players, turnover: cas.turnover, payout: cas.payout, wins: cas.wins, refunds: cas.refunds, ggr: cas.ggr },
    };
  });
  const native = byCurrency.find((b) => b.currency === ctx.cur);

  return {
    period: periodOut(p),
    context: { mode: ctx.mode, cur: ctx.cur, rate: ctx.rate },
    current,
    previous,
    wallet: { available: availC / 100, blocked: blockedC / 100, total: (availC + blockedC) / 100 },
    native: {
      currency: ctx.cur,
      deposits: native?.deposits.net ?? 0,
      withdrawals: native?.withdrawals.net ?? 0,
      casinoTurnover: native?.casino.turnover ?? 0,
      casinoPayout: native?.casino.payout ?? 0,
      casinoGgr: native?.casino.ggr ?? 0,
    },
    byCurrency,
  };
}

/** Abas Provedores e Jogos: o mesmo resultado do cassino quebrado por provedor e por jogo. */
export async function dashboardCasino(p: DashPeriod, q: Pick<DashQuery, "mode" | "cur">) {
  const params = await getDashboardParams();
  const ctx: Ctx = { mode: q.mode, cur: q.cur, rate: params.usdBrlRate };
  const raw = await loadLedger(p.start, p.end, CASINO_ONLY);
  ensureRate(ctx, raw.map((r) => r.currency));
  const rows = scopeLedger(raw, ctx);

  const perGame = new Map<string, MoneyRow[]>();
  for (const r of rows) {
    const k = r.gameId ?? "";
    (perGame.get(k) ?? perGame.set(k, []).get(k)!).push(r);
  }
  const ids = [...perGame.keys()].filter(Boolean);
  const games = await prisma.game.findMany({ where: { id: { in: ids } }, include: { provider: true } });
  const byId = new Map(games.map((g) => [g.id, g]));
  const total = playMetrics(rows, "casino");

  const gameRows = [...perGame].map(([gameId, list]) => {
    const g = byId.get(gameId);
    const m = playMetrics(list, "casino").metrics;
    return {
      gameId: gameId || null,
      name: g?.name ?? "Jogo não cadastrado",
      provider: g?.provider.name ?? "—",
      providerId: g?.providerId ?? null,
      integration: g?.integration ?? null,
      ...m,
      share: ratio(m.turnover, total.metrics.turnover),
    };
  }).sort((a, b) => b.turnover - a.turnover);

  const perProv = new Map<string, { name: string; rows: MoneyRow[]; games: Set<string> }>();
  for (const [gameId, list] of perGame) {
    const g = byId.get(gameId);
    const key = g?.providerId ?? "—";
    const e = perProv.get(key) ?? perProv.set(key, { name: g?.provider.name ?? "—", rows: [], games: new Set() }).get(key)!;
    e.rows.push(...list);
    e.games.add(gameId);
  }
  const providerRows = [...perProv].map(([providerId, e]) => {
    const m = playMetrics(e.rows, "casino").metrics; // jogadores distintos no provedor inteiro
    return { providerId: providerId === "—" ? null : providerId, name: e.name, games: e.games.size, ...m, share: ratio(m.turnover, total.metrics.turnover) };
  }).sort((a, b) => b.turnover - a.turnover);

  return { period: periodOut(p), context: { mode: ctx.mode, cur: ctx.cur, rate: ctx.rate }, totals: total.metrics, providers: providerRows, games: gameRows };
}

/** Aba Esportes: o mesmo resultado para os bilhetes, mais apostas em aberto. */
export async function dashboardSports(p: DashPeriod, q: Pick<DashQuery, "mode" | "cur">) {
  const params = await getDashboardParams();
  const ctx: Ctx = { mode: q.mode, cur: q.cur, rate: params.usdBrlRate };
  const [raw, open, slips] = await Promise.all([
    loadLedger(p.prevStart, p.end, ["BET_STAKE", "BET_WIN", "BET_REFUND"]),
    prisma.betslip.findMany({
      where: { status: "OPEN", user: { role: "PLAYER", isTest: false } },
      select: { stake: true, potentialReturn: true, user: { select: { wallet: { select: { currency: true } } } } },
    }),
    prisma.betslip.findMany({
      where: { createdAt: { gte: p.start, lt: p.end }, user: { role: "PLAYER", isTest: false } },
      select: { stake: true, payout: true, status: true, type: true, user: { select: { wallet: { select: { currency: true } } } } },
    }),
  ]);
  const curOf = (s: { user: { wallet: { currency: string } | null } }) => s.user.wallet?.currency ?? "BRL";
  ensureRate(ctx, [...raw.map((r) => r.currency), ...open.map(curOf), ...slips.map(curOf)]);
  const rows = scopeLedger(raw, ctx);
  const cur = playMetrics(rows.filter((r) => inWindow(r.at, p.start, p.end)), "sports");
  const prev = playMetrics(rows.filter((r) => inWindow(r.at, p.prevStart, p.prevEnd)), "sports");

  const conv = (v: Decimal | null, s: { user: { wallet: { currency: string } | null } }) => convertC(cents(v), curOf(s), ctx)!;
  let openStake = 0, openMax = 0, openCount = 0;
  for (const s of open) {
    if (!inScope(curOf(s), ctx)) continue;
    openCount++; openStake += conv(s.stake, s); openMax += conv(s.potentialReturn, s);
  }
  const group = (key: "status" | "type") => {
    const m = new Map<string, { count: number; stakeC: number; payoutC: number }>();
    for (const s of slips) {
      if (!inScope(curOf(s), ctx)) continue;
      const e = m.get(s[key]) ?? m.set(s[key], { count: 0, stakeC: 0, payoutC: 0 }).get(s[key])!;
      e.count++; e.stakeC += conv(s.stake, s); e.payoutC += conv(s.payout, s);
    }
    return [...m].map(([k, e]) => ({ key: k, count: e.count, stake: e.stakeC / 100, payout: e.payoutC / 100 }));
  };
  return {
    period: periodOut(p),
    context: { mode: ctx.mode, cur: ctx.cur, rate: ctx.rate },
    current: cur.metrics,
    previous: prev.metrics,
    open: { count: openCount, stake: openStake / 100, maxPayout: openMax / 100 },
    byStatus: group("status"),
    byType: group("type"),
  };
}

/**
 * Carteiras pré-pagas do agregador (PlayFivers /balances), com o GGR % cobrado e o saldo mínimo
 * definidos em Parâmetros. O GGR do período vem do nosso extrato, somando os jogos dos provedores
 * de cada carteira (mapa provedor → carteira de /providers).
 */
export async function dashboardWallets(p: DashPeriod) {
  const params = await getDashboardParams();
  const base = { configured: playfiversAdapter.configured(), panelUrl: params.panelUrl };
  if (!base.configured) return { ...base, items: [] as unknown[] };
  let balances: Record<string, number>;
  let providers: Awaited<ReturnType<typeof playfiversAdapter.listProviders>>;
  try {
    [balances, providers] = await Promise.all([playfiversAdapter.getBalances(), playfiversAdapter.listProviders()]);
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : "Falha ao consultar a PlayFivers", items: [] as unknown[] };
  }

  const rows = await prisma.walletTransaction.findMany({
    where: { createdAt: { gte: p.start, lt: p.end }, type: { in: CASINO_ONLY }, wallet: { user: { role: "PLAYER", isTest: false } }, game: { is: { integration: "playfivers" } } },
    select: { type: true, amount: true, wallet: { select: { userId: true } }, game: { select: { provider: { select: { name: true } } } } },
  });
  const byProvider = new Map<string, MoneyRow[]>();
  for (const r of rows) {
    const k = (r.game?.provider.name ?? "").toUpperCase();
    (byProvider.get(k) ?? byProvider.set(k, []).get(k)!).push({ type: r.type, c: cents(r.amount), userId: r.wallet.userId });
  }

  const items = Object.entries(balances).map(([name, balance]) => {
    const provs = providers.filter((pv) => pv.walletName === name).map((pv) => pv.name);
    const list = provs.flatMap((pv) => byProvider.get(pv.toUpperCase()) ?? []);
    const m = playMetrics(list, "casino");
    const prm = params.wallets[name] ?? { ggrPct: null, minBalance: DEFAULT_MIN_BALANCE };
    return {
      name,
      balance,
      providers: provs,
      ggrPct: prm.ggrPct,
      minBalance: prm.minBalance,
      periodGgr: m.metrics.ggr,
      periodTurnover: m.metrics.turnover,
      // custo estimado: o agregador cobra a % só sobre GGR positivo
      estFee: prm.ggrPct == null ? null : (Math.max(0, m.ggrC) * prm.ggrPct) / 100 / 100,
    };
  });
  return { ...base, items };
}
