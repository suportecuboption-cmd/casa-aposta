import type { Prisma, WalletTxType } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { opsRange, cents, r2, pageArgs, userName, activeRestrictionWhere } from "./ops-common.js";
import { dashPeriod, dashboardCasino } from "./dashboard.js";
import { KIND_PT } from "./protection.js";
import { userRisk } from "./risk.js";

const PLAYER_REAL = { role: "PLAYER" as const, isTest: false };

/* ═════════════════════════ Ranking Operacional ═════════════════════════ */

export async function rankingPlayers(q: { metric: "balance" | "deposits" | "withdrawals"; from?: string; to?: string; q?: string }) {
  const search = q.q?.trim();
  const userFilter: Prisma.UserWhereInput = { ...PLAYER_REAL, ...(search ? { OR: [{ email: { contains: search } }, { id: { contains: search } }] } : {}) };
  if (q.metric === "balance") {
    const wallets = await prisma.wallet.findMany({
      where: { user: userFilter, balance: { gt: 0 } },
      orderBy: { balance: "desc" },
      take: 20,
      select: { balance: true, updatedAt: true, user: { select: { id: true, email: true, displayName: true } } },
    });
    const agg = await prisma.wallet.aggregate({ where: { user: userFilter }, _max: { updatedAt: true } });
    return {
      metric: q.metric,
      aggregate: r2(wallets.reduce((s, w) => s + Number(w.balance), 0)),
      updatedAt: new Date(),
      lastMovementAt: agg._max.updatedAt,
      items: wallets.map((w, i) => ({ pos: i + 1, userId: w.user.id, email: w.user.email, name: userName(w.user), value: Number(w.balance), at: w.updatedAt })),
    };
  }
  const { from, to, start, end } = opsRange(q.from, q.to);
  const kind = q.metric === "deposits" ? "DEPOSIT" : "WITHDRAW";
  const groups = await prisma.pixOrder.groupBy({
    by: ["userId"],
    where: { kind, status: "PAID", paidAt: { gte: start, lt: end }, user: userFilter },
    _sum: { amount: true },
    _count: { _all: true },
    _max: { paidAt: true },
    orderBy: { _sum: { amount: "desc" } },
    take: 20,
  });
  const users = await prisma.user.findMany({ where: { id: { in: groups.map((g) => g.userId) } }, select: { id: true, email: true, displayName: true } });
  return {
    metric: q.metric,
    range: { from, to },
    aggregate: r2(groups.reduce((s, g) => s + Number(g._sum.amount ?? 0), 0)),
    updatedAt: new Date(),
    items: groups.map((g, i) => {
      const u = users.find((x) => x.id === g.userId)!;
      return { pos: i + 1, userId: g.userId, email: u?.email ?? g.userId, name: u ? userName(u) : g.userId, value: Number(g._sum.amount ?? 0), count: g._count._all, at: g._max.paidAt };
    }),
  };
}

export async function rankingGames(q: { by: "game" | "provider"; order: "desc" | "asc"; from?: string; to?: string }) {
  const p = dashPeriod(q.from, q.to);
  const c = await dashboardCasino(p, { mode: "native", cur: "BRL" });
  const rows = (q.by === "game" ? c.games : c.providers) as { ggr: number }[];
  const sorted = [...rows].sort((a, b) => (q.order === "desc" ? b.ggr - a.ggr : a.ggr - b.ggr));
  return { by: q.by, order: q.order, period: c.period, totals: c.totals, items: sorted.map((r, i) => ({ rank: i + 1, ...r })) };
}

/* ═════════════════════════ Gestão de Risco ═════════════════════════ */

const SCOPE_TYPES: Record<string, WalletTxType[]> = {
  casino: ["CASINO_BET", "CASINO_WIN", "CASINO_REFUND"],
  sports: ["BET_STAKE", "BET_WIN", "BET_REFUND"],
  all: ["CASINO_BET", "CASINO_WIN", "CASINO_REFUND", "BET_STAKE", "BET_WIN", "BET_REFUND"],
};

export interface RiskQuery { scope: "all" | "casino" | "sports"; from?: string; to?: string; provider?: string; game?: string }

/** Resultado por jogador no recorte: (prêmios + estornos) − apostas, do ponto de vista do jogador. */
async function playerResults(q: RiskQuery) {
  const { from, to, start, end } = opsRange(q.from, q.to);
  const gameFilter = q.game ? { gameId: q.game } : q.provider ? { game: { is: { providerId: q.provider } } } : {};
  const types = q.provider || q.game ? SCOPE_TYPES.casino : SCOPE_TYPES[q.scope];
  const rows = await prisma.walletTransaction.findMany({
    where: { createdAt: { gte: start, lt: end }, type: { in: types }, wallet: { user: PLAYER_REAL }, ...gameFilter },
    select: { type: true, amount: true, wallet: { select: { userId: true } }, game: { select: { name: true, provider: { select: { name: true } } } } },
  });
  const per = new Map<string, { stakeC: number; payoutC: number; bets: number; byLabel: Map<string, number> }>();
  for (const r of rows) {
    const uid = r.wallet.userId;
    const e = per.get(uid) ?? per.set(uid, { stakeC: 0, payoutC: 0, bets: 0, byLabel: new Map() }).get(uid)!;
    const c = cents(r.amount);
    const label = r.type.startsWith("BET_") ? "sportsbook" : `${r.game?.name ?? "Jogo"} · ${r.game?.provider.name ?? "—"}`;
    if (r.type === "CASINO_BET" || r.type === "BET_STAKE") { e.stakeC -= c; e.bets++; } else e.payoutC += c;
    e.byLabel.set(label, (e.byLabel.get(label) ?? 0) + c);
  }
  const users = await prisma.user.findMany({ where: { id: { in: [...per.keys()] } }, select: { id: true, email: true, displayName: true } });
  const list = [...per].map(([uid, e]) => {
    const u = users.find((x) => x.id === uid);
    const net = e.payoutC - e.stakeC;
    const labels = [...e.byLabel];
    const pick = labels.sort((a, b) => (net >= 0 ? b[1] - a[1] : a[1] - b[1]))[0];
    return {
      userId: uid, name: u ? userName(u) : uid, email: u?.email ?? uid, bets: e.bets,
      turnover: e.stakeC / 100, payout: e.payoutC / 100, net: net / 100, rtp: e.stakeC ? e.payoutC / e.stakeC : 0, main: pick?.[0] ?? "—",
    };
  });
  return { from, to, list };
}

export async function riskOverview(q: RiskQuery) {
  const [{ from, to, list }, alerts] = await Promise.all([playerResults(q), getRiskAlerts()]);
  const stake = list.reduce((s, x) => s + x.turnover, 0), payout = list.reduce((s, x) => s + x.payout, 0);
  const winners = list.filter((x) => x.net > 0).sort((a, b) => b.net - a.net);
  const losers = list.filter((x) => x.net < 0).sort((a, b) => a.net - b.net);
  // Opções dos filtros: provedores e jogos de cassino com atividade no período.
  const { start, end } = opsRange(q.from, q.to);
  const active = await prisma.walletTransaction.groupBy({ by: ["gameId"], where: { createdAt: { gte: start, lt: end }, type: "CASINO_BET", gameId: { not: null }, wallet: { user: PLAYER_REAL } } });
  const games = await prisma.game.findMany({ where: { id: { in: active.map((g) => g.gameId!) } }, select: { id: true, name: true, providerId: true, provider: { select: { name: true } } } });
  const providers = [...new Map(games.map((g) => [g.providerId, { id: g.providerId, name: g.provider.name }])).values()];
  return {
    range: { from, to },
    kpis: {
      winnersTotal: r2(winners.reduce((s, x) => s + x.net, 0)),
      playersResult: r2(list.reduce((s, x) => s + x.net, 0)),
      positiveUsers: winners.length,
      totalUsers: list.length,
      avgRtp: stake ? payout / stake : 0,
    },
    winners: winners.slice(0, 5),
    losers: losers.slice(0, 5),
    alerts: alerts.bigWinAmount != null ? winners.filter((x) => x.net >= alerts.bigWinAmount!) : [],
    alertConfig: alerts,
    providers,
    games: games.filter((g) => !q.provider || g.providerId === q.provider).map((g) => ({ id: g.id, name: g.name, providerId: g.providerId })),
  };
}

export async function riskResults(q: RiskQuery & { page: number; size: number; sort: "net" | "turnover"; dir: "asc" | "desc" }) {
  const { from, to, list } = await playerResults(q);
  const sorted = [...list].sort((a, b) => (q.dir === "desc" ? b[q.sort] - a[q.sort] : a[q.sort] - b[q.sort]));
  return { range: { from, to }, total: sorted.length, page: q.page, size: q.size, items: sorted.slice((q.page - 1) * q.size, q.page * q.size) };
}

/** Score de risco dos jogadores com atividade no período (até 60, maiores primeiro). */
export async function riskScores(q: RiskQuery) {
  const { from, to, list } = await playerResults(q);
  const top = [...list].sort((a, b) => b.turnover - a.turnover).slice(0, 60);
  const scored = await Promise.all(top.map(async (u) => ({ ...u, risk: await userRisk(u.userId).catch(() => null) })));
  return { range: { from, to }, items: scored.filter((s) => s.risk).sort((a, b) => b.risk!.score - a.risk!.score) };
}

const ALERTS_KEY = "riskAlerts";
export interface RiskAlerts { bigWinAmount: number | null }
export async function getRiskAlerts(): Promise<RiskAlerts> {
  const row = await prisma.siteSetting.findUnique({ where: { key: ALERTS_KEY } });
  if (!row) return { bigWinAmount: null };
  try { return { bigWinAmount: null, ...JSON.parse(row.value) }; } catch { return { bigWinAmount: null }; }
}
export async function saveRiskAlerts(a: RiskAlerts, adminId: string) {
  const value = JSON.stringify(a);
  await prisma.$transaction([
    prisma.siteSetting.upsert({ where: { key: ALERTS_KEY }, create: { key: ALERTS_KEY, value }, update: { value } }),
    prisma.adminAuditLog.create({ data: { adminId, action: "RISK_ALERTS_UPDATE", target: ALERTS_KEY, payload: value } }),
  ]);
  return a;
}

/* ═════════════════════════ Bloqueios e Autoexclusões ═════════════════════════ */

export async function restrictionsList(q: { type?: string; action?: string; from?: string; to?: string; q?: string; page: number; size: number }) {
  const now = new Date();
  const { from, to, start, end } = opsRange(q.from, q.to, 8);
  const search = q.q?.trim();
  const base: Prisma.UserRestrictionWhereInput = {
    createdAt: { gte: start, lt: end },
    ...(search ? { user: { OR: [{ email: { contains: search } }, { displayName: { contains: search } }] } } : {}),
  };
  const where: Prisma.UserRestrictionWhereInput = {
    ...base,
    ...(q.type && q.type !== "all" ? { kind: q.type } : {}),
    ...(q.action === "active" ? activeRestrictionWhere(now) : {}),
    ...(q.action === "changed" ? { changedAt: { not: null } } : {}),
    ...(q.action === "revoked" ? { revokedAt: { not: null } } : {}),
    ...(q.action === "expired" ? { revokedAt: null, endsAt: { lte: now } } : {}),
  };
  const [groups, changed, items, total] = await Promise.all([
    prisma.userRestriction.groupBy({ by: ["kind"], where: base, _count: { _all: true } }),
    prisma.userRestriction.groupBy({ by: ["kind"], where: { ...base, changedAt: { not: null } }, _count: { _all: true } }),
    prisma.userRestriction.findMany({
      where,
      orderBy: { createdAt: "desc" },
      ...pageArgs(q.page, q.size),
      include: { user: { select: { id: true, email: true, displayName: true } } },
    }),
    prisma.userRestriction.count({ where }),
  ]);
  const authors = await prisma.user.findMany({ where: { id: { in: items.map((i) => i.createdBy).filter((x): x is string => !!x) } }, select: { id: true, email: true } });
  const c = (kind: string) => groups.find((g) => g.kind === kind)?._count._all ?? 0;
  const ch = (kind: string) => changed.find((g) => g.kind === kind)?._count._all ?? 0;
  return {
    range: { from, to },
    kpis: {
      total: groups.reduce((s, g) => s + g._count._all, 0),
      selfExclusions: c("SELF_EXCLUSION"), selfChanged: ch("SELF_EXCLUSION"),
      manualBlocks: c("MANUAL_BLOCK"),
      suspensions: c("SUSPENSION"), suspensionsChanged: ch("SUSPENSION"),
    },
    total,
    page: q.page,
    size: q.size,
    items: items.map((r) => {
      const status = r.revokedAt ? "Retirada" : r.endsAt && r.endsAt <= now ? "Expirada" : r.scope === "TOTAL" ? "Aplicada · total" : "Aplicada";
      return {
        id: r.id, user: { id: r.user.id, name: userName(r.user), email: r.user.email }, kind: r.kind, kindPt: KIND_PT[r.kind] ?? r.kind,
        status, changed: !!r.changedAt, reason: r.reason, detail: r.detail,
        author: r.createdBy ? authors.find((a) => a.id === r.createdBy)?.email ?? "equipe" : "Próprio usuário",
        createdAt: r.createdAt, endsAt: r.endsAt, revokedAt: r.revokedAt,
      };
    }),
  };
}

/* ═════════════════════════ Ajustes de saldo ═════════════════════════ */

export async function adjustmentsList(q: { from?: string; to?: string; q?: string; direction?: "all" | "credit" | "debit"; page: number; size: number }) {
  const { from, to, start, end } = opsRange(q.from, q.to);
  const search = q.q?.trim();
  const base: Prisma.WalletTransactionWhereInput = {
    type: "ADJUSTMENT",
    createdAt: { gte: start, lt: end },
    wallet: { user: { role: "PLAYER", ...(search ? { OR: [{ email: { contains: search } }, { displayName: { contains: search } }, { id: { contains: search } }] } : {}) } },
  };
  const where: Prisma.WalletTransactionWhereInput = {
    ...base,
    ...(q.direction === "credit" ? { amount: { gt: 0 } } : q.direction === "debit" ? { amount: { lt: 0 } } : {}),
  };
  const [pos, neg, items, total] = await Promise.all([
    prisma.walletTransaction.aggregate({ where: { ...base, amount: { gt: 0 } }, _sum: { amount: true }, _count: { _all: true } }),
    prisma.walletTransaction.aggregate({ where: { ...base, amount: { lt: 0 } }, _sum: { amount: true }, _count: { _all: true } }),
    prisma.walletTransaction.findMany({
      where,
      orderBy: { createdAt: "desc" },
      ...pageArgs(q.page, q.size),
      select: { id: true, amount: true, balanceAfter: true, reference: true, meta: true, createdAt: true, wallet: { select: { user: { select: { id: true, email: true, displayName: true, isTest: true } } } } },
    }),
    prisma.walletTransaction.count({ where }),
  ]);
  const adminIds = items.map((i) => i.reference?.startsWith("admin:") ? i.reference.slice(6) : null).filter((x): x is string => !!x);
  const admins = await prisma.user.findMany({ where: { id: { in: adminIds } }, select: { id: true, email: true } });
  const added = Number(pos._sum.amount ?? 0), subtracted = -Number(neg._sum.amount ?? 0);
  return {
    range: { from, to },
    kpis: { count: pos._count._all + neg._count._all, added: r2(added), subtracted: r2(subtracted), net: r2(added - subtracted) },
    total,
    page: q.page,
    size: q.size,
    items: items.map((i) => {
      let reason = "—";
      try { reason = i.meta ? JSON.parse(i.meta).reason ?? "—" : "—"; } catch { /* sem motivo */ }
      const adminId = i.reference?.startsWith("admin:") ? i.reference.slice(6) : null;
      return {
        id: i.id, at: i.createdAt, amount: Number(i.amount), balanceAfter: Number(i.balanceAfter), reason,
        admin: adminId ? admins.find((a) => a.id === adminId)?.email ?? "equipe" : "sistema",
        user: { id: i.wallet.user.id, name: userName(i.wallet.user), email: i.wallet.user.email, isTest: i.wallet.user.isTest },
      };
    }),
  };
}
