import type { Prisma } from "@prisma/client";
import bcrypt from "bcryptjs";
import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";
import { dayKey } from "./reports.js";
import { opsRange, dayList, cents, r2, pageArgs, userName, activeRestrictionWhere, isLocalIp } from "./ops-common.js";
import {
  accessMode,
  restrictionActive,
  KIND_PT,
  getHouseWithdrawLimits,
  effectiveWithdrawLimits,
  type WithdrawLimits,
} from "./protection.js";
import { userRisk } from "./risk.js";

const DAY = 86_400_000;
const num = (v: unknown) => (v == null ? null : Number(v));
const PLAY_TYPES = ["CASINO_BET", "CASINO_WIN", "CASINO_REFUND", "BET_STAKE", "BET_WIN", "BET_REFUND"] as const;

async function adminEmails(ids: (string | null | undefined)[]) {
  const list = [...new Set(ids.filter((x): x is string => !!x))];
  if (!list.length) return new Map<string, string>();
  const rows = await prisma.user.findMany({ where: { id: { in: list } }, select: { id: true, email: true } });
  return new Map(rows.map((r) => [r.id, r.email]));
}

/* ═════════════════════════ lista de usuários ═════════════════════════ */

export interface UsersQuery {
  q?: string;
  account?: "all" | "active" | "blocked" | "test" | "restricted";
  kyc?: "all" | "none" | "verified";
  activity?: "all" | "active30" | "inactive30";
  signup?: "all" | "today" | "7d" | "30d";
  page: number;
  size: number;
  sort: "name" | "createdAt";
  dir: "asc" | "desc";
}

/** Ativos (30 dias) = acessaram o site ou movimentaram a carteira nos últimos 30 dias. */
async function activeIds30(now = new Date()) {
  const since = new Date(now.getTime() - 30 * DAY);
  const [acts, txs] = await Promise.all([
    prisma.userActivity.groupBy({ by: ["userId"], where: { at: { gte: since } } }),
    prisma.walletTransaction.groupBy({ by: ["walletId"], where: { createdAt: { gte: since } } }),
  ]);
  const wallets = txs.length ? await prisma.wallet.findMany({ where: { id: { in: txs.map((t) => t.walletId) } }, select: { userId: true } }) : [];
  return [...new Set([...acts.map((a) => a.userId), ...wallets.map((w) => w.userId)])];
}

function signupSince(s: string, now: Date) {
  if (s === "today") return new Date(`${dayKey(now)}T00:00:00-03:00`);
  return new Date(now.getTime() - (s === "7d" ? 7 : 30) * DAY);
}

export async function usersList(q: UsersQuery) {
  const now = new Date();
  const active = await activeIds30(now);
  const conds: Prisma.UserWhereInput[] = [{ role: "PLAYER" }];
  const search = q.q?.trim();
  if (search) {
    const digits = search.replace(/\D/g, "");
    conds.push({
      OR: [
        { email: { contains: search } },
        { displayName: { contains: search } },
        { id: { contains: search } },
        ...(digits.length >= 3 ? [{ cpf: { contains: digits } }, { phone: { contains: digits } }] : []),
      ],
    });
  }
  if (q.account === "active") conds.push({ isActive: true, isTest: false });
  if (q.account === "blocked") conds.push({ isActive: false });
  if (q.account === "test") conds.push({ isTest: true });
  if (q.account === "restricted") conds.push({ restrictions: { some: activeRestrictionWhere(now) } });
  if (q.kyc === "verified") conds.push({ kyc: { is: { verified: true } } });
  if (q.kyc === "none") conds.push({ OR: [{ kyc: { is: null } }, { kyc: { is: { verified: false } } }] });
  if (q.activity === "active30") conds.push({ id: { in: active } });
  if (q.activity === "inactive30") conds.push({ id: { notIn: active } });
  if (q.signup && q.signup !== "all") conds.push({ createdAt: { gte: signupSince(q.signup, now) } });
  const where: Prisma.UserWhereInput = { AND: conds };

  const [items, total, all, test, active30] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: q.sort === "name" ? [{ displayName: q.dir }, { email: q.dir }] : { createdAt: q.dir },
      ...pageArgs(q.page, q.size),
      select: {
        id: true, email: true, displayName: true, cpf: true, phone: true, createdAt: true, isActive: true, isTest: true,
        kyc: { select: { verified: true } },
        restrictions: { where: activeRestrictionWhere(now), select: { kind: true, scope: true, startsAt: true, endsAt: true, revokedAt: true } },
      },
    }),
    prisma.user.count({ where }),
    prisma.user.count({ where: { role: "PLAYER" } }),
    prisma.user.count({ where: { role: "PLAYER", isTest: true } }),
    prisma.user.count({ where: { role: "PLAYER", id: { in: active } } }),
  ]);
  return {
    kpis: { total: all, active30, activeShare: all ? active30 / all : 0, test, testShare: all ? test / all : 0 },
    total,
    page: q.page,
    size: q.size,
    items: items.map((u) => ({
      id: u.id,
      name: userName(u),
      email: u.email,
      cpf: u.cpf,
      phone: u.phone,
      createdAt: u.createdAt,
      isActive: u.isActive,
      isTest: u.isTest,
      kyc: u.kyc?.verified ? "verified" : "none",
      mode: accessMode(u.isActive, u.restrictions, now),
      restriction: u.restrictions[0]?.kind ?? null,
    })),
  };
}

/** Conta de teste: jogador de verdade no sistema, mas fora das métricas, rankings e vitrine. */
export async function createTestAccount(input: { name: string; email: string; password: string; initialBalance: number }, adminId: string) {
  const email = input.email.trim().toLowerCase();
  if (await prisma.user.findUnique({ where: { email } })) throw new AppError("E-mail já cadastrado", 409, "CONFLICT");
  const passwordHash = await bcrypt.hash(input.password, 10);
  const user = await prisma.$transaction(async (tx) => {
    const u = await tx.user.create({
      data: { email, passwordHash, displayName: input.name.trim(), isTest: true, wallet: { create: {} } },
      include: { wallet: true },
    });
    if (input.initialBalance > 0) {
      const amount = new Decimal(input.initialBalance).toDecimalPlaces(2);
      const w = await tx.wallet.update({ where: { id: u.wallet!.id }, data: { balance: { increment: amount } } });
      await tx.walletTransaction.create({
        data: { walletId: w.id, type: "ADJUSTMENT", amount, balanceAfter: w.balance, reference: `admin:${adminId}`, meta: JSON.stringify({ reason: "Saldo inicial de conta teste" }) },
      });
    }
    await tx.adminAuditLog.create({ data: { adminId, action: "TEST_ACCOUNT_CREATE", target: u.id, payload: JSON.stringify({ email, initialBalance: input.initialBalance }) } });
    return u;
  });
  return { id: user.id, email };
}

export async function setTestFlag(userId: string, isTest: boolean, adminId: string) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { isTest: true } });
  if (!u) throw new AppError("Usuário não encontrado", 404, "NOT_FOUND");
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { isTest } }),
    prisma.adminAuditLog.create({ data: { adminId, action: "TEST_FLAG", target: userId, payload: JSON.stringify({ before: u.isTest, after: isTest }) } }),
  ]);
  return { isTest };
}

/* ═════════════════════════ ficha do jogador ═════════════════════════ */

export async function userDetail(id: string) {
  const now = new Date();
  const u = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true, email: true, displayName: true, cpf: true, phone: true, role: true, isActive: true, isTest: true, createdAt: true,
      kyc: { select: { level: true, verified: true, documents: true, updatedAt: true } },
      wallet: { select: { id: true, balance: true, bonus: true, currency: true } },
      restrictions: { orderBy: { createdAt: "desc" } },
      rgLimits: { orderBy: { createdAt: "desc" } },
      withdrawLimit: true,
    },
  });
  if (!u) throw new AppError("Usuário não encontrado", 404, "NOT_FOUND");
  const walletId = u.wallet?.id;
  const since30 = new Date(now.getTime() - 30 * DAY);
  const noRows = Promise.resolve([] as never[]);
  const [pix, firstDep, lastDep, ledger, ledger30, adjRows, lastBet, topGame, lastAct, pendingWd, house, risk, logs] = await Promise.all([
    prisma.pixOrder.groupBy({ by: ["kind", "status"], where: { userId: id }, _sum: { amount: true }, _count: { _all: true } }),
    prisma.pixOrder.findFirst({ where: { userId: id, kind: "DEPOSIT", status: "PAID" }, orderBy: { paidAt: "asc" }, select: { amount: true, paidAt: true } }),
    prisma.pixOrder.findFirst({ where: { userId: id, kind: "DEPOSIT", status: "PAID" }, orderBy: { paidAt: "desc" }, select: { amount: true, paidAt: true } }),
    walletId ? prisma.walletTransaction.groupBy({ by: ["type"], where: { walletId }, _sum: { amount: true }, _count: { _all: true } }) : noRows,
    walletId ? prisma.walletTransaction.groupBy({ by: ["type"], where: { walletId, createdAt: { gte: since30 } }, _sum: { amount: true } }) : noRows,
    walletId ? prisma.walletTransaction.findMany({ where: { walletId, type: { in: ["ADJUSTMENT", "BONUS"] } }, select: { type: true, amount: true } }) : noRows,
    walletId ? prisma.walletTransaction.findFirst({ where: { walletId, type: { in: ["CASINO_BET", "BET_STAKE"] } }, orderBy: { createdAt: "desc" }, select: { createdAt: true, type: true, game: { select: { name: true } } } }) : Promise.resolve(null),
    walletId ? prisma.walletTransaction.groupBy({ by: ["gameId"], where: { walletId, type: "CASINO_BET", gameId: { not: null } }, _sum: { amount: true }, orderBy: { _sum: { amount: "asc" } }, take: 1 }) : noRows,
    prisma.userActivity.findFirst({ where: { userId: id }, orderBy: { at: "desc" }, select: { at: true, ip: true } }),
    prisma.pixOrder.count({ where: { userId: id, kind: "WITHDRAW", status: "PENDING" } }),
    getHouseWithdrawLimits(),
    userRisk(id).catch(() => null),
    prisma.adminAuditLog.findMany({ where: { target: id }, orderBy: { createdAt: "desc" }, take: 200 }),
  ]);

  const p = (kind: string, status: string) => pix.find((x) => x.kind === kind && x.status === status);
  const sumT = (rows: { type: string; _sum: { amount: unknown } }[], types: readonly string[]) => rows.filter((r) => types.includes(r.type)).reduce((s, r) => s + Number(r._sum.amount ?? 0), 0);
  const countT = (types: string[]) => (ledger as { type: string; _count: { _all: number } }[]).filter((r) => types.includes(r.type)).reduce((s, r) => s + r._count._all, 0);
  const deposited = Number(p("DEPOSIT", "PAID")?._sum.amount ?? 0), withdrawn = Number(p("WITHDRAW", "PAID")?._sum.amount ?? 0);
  const staked = -sumT(ledger, ["BET_STAKE", "CASINO_BET"]);
  const ggr = -sumT(ledger, PLAY_TYPES);
  const topGameRow = topGame[0] ? await prisma.game.findUnique({ where: { id: topGame[0].gameId! }, select: { name: true, provider: { select: { name: true } } } }) : null;
  const adj = { added: 0, addedN: 0, subtracted: 0, subtractedN: 0, bonus: 0, bonusN: 0 };
  for (const r of adjRows as { type: string; amount: unknown }[]) {
    const v = Number(r.amount);
    if (r.type === "BONUS") { adj.bonus += v; adj.bonusN++; } else if (v >= 0) { adj.added += v; adj.addedN++; } else { adj.subtracted += -v; adj.subtractedN++; }
  }

  const mode = accessMode(u.isActive, u.restrictions, now);
  const emails = await adminEmails([...u.restrictions.flatMap((r) => [r.createdBy, r.revokedBy]), ...u.rgLimits.flatMap((l) => [l.createdBy, l.removedBy]), u.withdrawLimit?.updatedBy, ...logs.map((l) => l.adminId)]);
  const by = (adminId: string | null | undefined) => (adminId ? emails.get(adminId) ?? "equipe" : "Próprio usuário");
  const individual: Partial<WithdrawLimits> | null = u.withdrawLimit
    ? { maxPerWithdrawal: num(u.withdrawLimit.maxPerWithdrawal), dailyAmount: num(u.withdrawLimit.dailyAmount), dailyCount: u.withdrawLimit.dailyCount, minIntervalMin: u.withdrawLimit.minIntervalMin }
    : null;
  const eff = effectiveWithdrawLimits(house, individual);
  const selfExcl = u.restrictions.find((r) => r.kind === "SELF_EXCLUSION" && restrictionActive(r, now));
  const kycStatus = u.kyc?.verified ? "Aprovado" : u.kyc?.documents ? "Em análise" : "Não iniciado";

  // Histórico da proteção (restrições, limites e ações da equipe sobre a conta).
  const history = [
    ...u.restrictions.flatMap((r) => [
      { at: r.createdAt, tone: "red", label: `Aplicou ${KIND_PT[r.kind]?.toLowerCase()}`, note: `motivo: ${r.reason}`, by: by(r.createdBy) },
      ...(r.revokedAt ? [{ at: r.revokedAt, tone: "green", label: `Retirou ${KIND_PT[r.kind]?.toLowerCase()}`, note: r.revokeNote ?? "", by: by(r.revokedBy) }] : []),
    ]),
    ...u.rgLimits.flatMap((l) => [
      { at: l.createdAt, tone: "gray", label: "Configurou limite de jogo responsável", note: `${l.kind} · ${l.period} · ${Number(l.amount)}`, by: by(l.createdBy) },
      ...(l.removedAt ? [{ at: l.removedAt, tone: "gray", label: "Removeu limite de jogo responsável", note: `${l.kind} · ${l.period}`, by: by(l.removedBy) }] : []),
    ]),
    ...logs.filter((l) => ["RESTRICTION_EDIT", "WITHDRAW_LIMITS_SET", "USER_UPDATE"].includes(l.action)).map((l) => ({
      at: l.createdAt, tone: "gray",
      label: l.action === "RESTRICTION_EDIT" ? "Editou prazo da restrição" : l.action === "WITHDRAW_LIMITS_SET" ? "Alterou limite de saque individual" : "Alterou a conta",
      note: l.payload ?? "", by: emails.get(l.adminId) ?? "equipe",
    })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());

  return {
    user: {
      id: u.id, name: userName(u), email: u.email, phone: u.phone, cpf: u.cpf, role: u.role, isActive: u.isActive, isTest: u.isTest,
      createdAt: u.createdAt, birthDate: null, lastIp: lastAct?.ip ?? null, lastSeenAt: lastAct?.at ?? null,
    },
    wallet: { balance: Number(u.wallet?.balance ?? 0), bonus: Number(u.wallet?.bonus ?? 0), currency: u.wallet?.currency ?? "BRL" },
    quick: {
      lastDeposit: lastDep ? Number(lastDep.amount) : 0,
      lastDepositAt: lastDep?.paidAt ?? null,
      firstDeposit: firstDep ? Number(firstDep.amount) : 0,
      depositsCount: p("DEPOSIT", "PAID")?._count._all ?? 0,
      withdrawalsCount: p("WITHDRAW", "PAID")?._count._all ?? 0,
    },
    overview: {
      netDepositsLifetime: r2(deposited - withdrawn),
      netDeposits30d: r2(sumT(ledger30, ["DEPOSIT", "WITHDRAW"])),
      ggrLifetime: r2(ggr),
      deposited: r2(deposited), depositedN: p("DEPOSIT", "PAID")?._count._all ?? 0,
      withdrawn: r2(withdrawn), withdrawnN: p("WITHDRAW", "PAID")?._count._all ?? 0,
      adjustments: { added: r2(adj.added), addedN: adj.addedN, subtracted: r2(adj.subtracted), subtractedN: adj.subtractedN },
      bonus: { received: r2(adj.bonus), receivedN: adj.bonusN },
      bets: { count: countT(["CASINO_BET", "BET_STAKE"]), staked: r2(staked), lastAt: lastBet?.createdAt ?? null, lastGame: lastBet ? (lastBet.type === "BET_STAKE" ? "Esportes" : lastBet.game?.name ?? "—") : null, topProvider: topGameRow?.provider.name ?? null },
      pending: { withdrawals: pendingWd, kycSent: kycStatus === "Em análise", selfExclusion: !!selfExcl },
    },
    kyc: { status: kycStatus, level: u.kyc?.level ?? 0, verified: !!u.kyc?.verified, updatedAt: u.kyc?.updatedAt ?? null },
    risk,
    protection: {
      mode,
      restrictions: u.restrictions.map((r) => ({
        id: r.id, kind: r.kind, kindPt: KIND_PT[r.kind], scope: r.scope, reason: r.reason, detail: r.detail,
        startsAt: r.startsAt, endsAt: r.endsAt, createdAt: r.createdAt, revokedAt: r.revokedAt, revokeNote: r.revokeNote,
        active: restrictionActive(r, now), by: by(r.createdBy), selfApplied: !r.createdBy,
      })),
      limits: u.rgLimits.filter((l) => !l.removedAt).map((l) => ({ id: l.id, kind: l.kind, period: l.period, amount: Number(l.amount), createdAt: l.createdAt, by: by(l.createdBy) })),
      history,
    },
    withdrawLimits: { house, individual, effective: eff.limits, source: eff.source, updatedAt: u.withdrawLimit?.updatedAt ?? null, updatedBy: u.withdrawLimit ? by(u.withdrawLimit.updatedBy) : null },
  };
}

/* ═════════════════════════ abas da ficha ═════════════════════════ */

/** Apostas: rodadas de cassino (agrupadas por rodada) e bilhetes de esporte no período. */
export async function userBets(id: string, q: { from?: string; to?: string; q?: string; page: number; size: number }) {
  const { from, to, start, end } = opsRange(q.from, q.to);
  const wallet = await prisma.wallet.findUnique({ where: { userId: id }, select: { id: true } });
  const [txs, slips] = await Promise.all([
    wallet
      ? prisma.walletTransaction.findMany({
          where: { walletId: wallet.id, createdAt: { gte: start, lt: end }, type: { in: ["CASINO_BET", "CASINO_WIN", "CASINO_REFUND"] } },
          select: { id: true, type: true, amount: true, roundId: true, createdAt: true, gameId: true, game: { select: { name: true, provider: { select: { name: true } } } } },
          orderBy: { createdAt: "asc" },
        })
      : Promise.resolve([]),
    prisma.betslip.findMany({ where: { userId: id, createdAt: { gte: start, lt: end } }, include: { selections: true }, orderBy: { createdAt: "asc" } }),
  ]);
  const rounds = new Map<string, { at: Date; game: string; provider: string; roundId: string | null; stakeC: number; payoutC: number; type: string; status: string }>();
  for (const t of txs) {
    const k = `${t.gameId}|${t.roundId ?? t.id}`;
    const e = rounds.get(k) ?? rounds.set(k, { at: t.createdAt, game: t.game?.name ?? "Jogo", provider: t.game?.provider.name ?? "—", roundId: t.roundId, stakeC: 0, payoutC: 0, type: "Cassino", status: "Liquidada" }).get(k)!;
    const c = cents(t.amount);
    if (t.type === "CASINO_BET") e.stakeC -= c; else e.payoutC += c;
  }
  const rows = [
    ...[...rounds.values()],
    ...slips.map((s) => ({
      at: s.createdAt, game: "Esportes", provider: s.type === "MULTIPLE" ? `Acumulada · ${s.selections.length} seleções` : "Simples",
      roundId: s.id, stakeC: cents(s.stake), payoutC: cents(s.payout), type: "Esportes",
      status: ({ OPEN: "Em aberto", WON: "Ganhou", LOST: "Perdeu", VOID: "Devolvida", CASHED_OUT: "Encerrada" } as Record<string, string>)[s.status] ?? s.status,
    })),
  ];
  const search = q.q?.trim().toLowerCase();
  const filtered = (search ? rows.filter((r) => `${r.game} ${r.provider} ${r.roundId ?? ""}`.toLowerCase().includes(search)) : rows).sort((a, b) => b.at.getTime() - a.at.getTime());
  const turnoverC = filtered.reduce((s, r) => s + r.stakeC, 0), payoutC = filtered.reduce((s, r) => s + r.payoutC, 0);
  return {
    range: { from, to },
    kpis: { rounds: filtered.length, turnover: turnoverC / 100, payout: payoutC / 100, ggr: (turnoverC - payoutC) / 100 },
    total: filtered.length,
    page: q.page,
    size: q.size,
    items: filtered.slice((q.page - 1) * q.size, q.page * q.size).map((r) => ({
      at: r.at, game: r.game, provider: r.provider, roundId: r.roundId, type: r.type, status: r.status,
      turnover: r.stakeC / 100, payout: r.payoutC / 100, result: (r.payoutC - r.stakeC) / 100,
    })),
  };
}

export async function userTopGames(id: string, q: { from?: string; to?: string }) {
  const { from, to, start, end } = opsRange(q.from, q.to);
  const wallet = await prisma.wallet.findUnique({ where: { userId: id }, select: { id: true } });
  if (!wallet) return { range: { from, to }, items: [] };
  const groups = await prisma.walletTransaction.groupBy({
    by: ["gameId", "type"],
    where: { walletId: wallet.id, createdAt: { gte: start, lt: end }, type: { in: ["CASINO_BET", "CASINO_WIN", "CASINO_REFUND"] }, gameId: { not: null } },
    _sum: { amount: true },
    _count: { _all: true },
  });
  const games = await prisma.game.findMany({ where: { id: { in: [...new Set(groups.map((g) => g.gameId!))] } }, select: { id: true, name: true, provider: { select: { name: true } } } });
  const map = new Map<string, { rounds: number; stakeC: number; payoutC: number }>();
  for (const g of groups) {
    const e = map.get(g.gameId!) ?? map.set(g.gameId!, { rounds: 0, stakeC: 0, payoutC: 0 }).get(g.gameId!)!;
    if (g.type === "CASINO_BET") { e.stakeC -= cents(g._sum.amount); e.rounds += g._count._all; } else e.payoutC += cents(g._sum.amount);
  }
  return {
    range: { from, to },
    items: [...map].map(([gid, e]) => {
      const gm = games.find((x) => x.id === gid);
      return { gameId: gid, name: gm?.name ?? "Jogo", provider: gm?.provider.name ?? "—", rounds: e.rounds, turnover: e.stakeC / 100, payout: e.payoutC / 100, ggr: (e.stakeC - e.payoutC) / 100 };
    }).sort((a, b) => b.turnover - a.turnover),
  };
}

const CATEGORY: Record<string, string> = {
  DEPOSIT: "deposits", WITHDRAW: "withdrawals", CASINO_BET: "casino", CASINO_WIN: "casino", CASINO_REFUND: "casino",
  BET_STAKE: "sports", BET_WIN: "sports", BET_REFUND: "sports", ADJUSTMENT: "adjustments", BONUS: "bonus",
};

/** Extrato: saldo no começo/fim, entradas e saídas, evolução do saldo e lançamentos. */
export async function userLedger(id: string, q: { from?: string; to?: string; category?: string; q?: string; page: number; size: number }) {
  const { from, to, start, end } = opsRange(q.from, q.to);
  const wallet = await prisma.wallet.findUnique({ where: { userId: id }, select: { id: true } });
  if (!wallet) throw new AppError("Carteira inexistente", 404, "NOT_FOUND");
  const [before, rows] = await Promise.all([
    prisma.walletTransaction.findFirst({ where: { walletId: wallet.id, createdAt: { lt: start } }, orderBy: { createdAt: "desc" }, select: { balanceAfter: true } }),
    prisma.walletTransaction.findMany({
      where: { walletId: wallet.id, createdAt: { gte: start, lt: end } },
      orderBy: { createdAt: "asc" },
      select: { id: true, type: true, amount: true, balanceAfter: true, reference: true, meta: true, roundId: true, createdAt: true, game: { select: { name: true } } },
    }),
  ]);
  const startBal = before ? Number(before.balanceAfter) : 0;
  const endBal = rows.length ? Number(rows[rows.length - 1].balanceAfter) : startBal;
  const days = dayList(from, to);
  const byDay = new Map(days.map((d) => [d, { inC: 0, outC: 0, bal: null as number | null }]));
  for (const r of rows) {
    const e = byDay.get(dayKey(r.createdAt));
    if (!e) continue;
    const c = cents(r.amount);
    if (c >= 0) e.inC += c; else e.outC += -c;
    e.bal = Number(r.balanceAfter);
  }
  let carry = startBal;
  const balance = days.map((d) => { const e = byDay.get(d)!; if (e.bal != null) carry = e.bal; return { date: d, balance: carry }; });
  const flows = days.map((d) => ({ date: d, in: byDay.get(d)!.inC / 100, out: byDay.get(d)!.outC / 100 }));

  const search = q.q?.trim().toLowerCase();
  const filtered = rows.filter((r) => (!q.category || q.category === "all" || CATEGORY[r.type] === q.category)
    && (!search || `${r.id} ${r.type} ${r.reference ?? ""} ${r.game?.name ?? ""} ${r.roundId ?? ""}`.toLowerCase().includes(search)));
  let inC = 0, inN = 0, outC = 0, outN = 0;
  for (const r of filtered) { const c = cents(r.amount); if (c >= 0) { inC += c; inN++; } else { outC += -c; outN++; } }
  const detail = (r: (typeof rows)[number]) => {
    if (r.game) return `${r.game.name}${r.roundId ? ` · rodada ${r.roundId.slice(-8)}` : ""}`;
    if (r.meta) { try { const m = JSON.parse(r.meta); if (m.reason) return m.reason; } catch { /* sem meta */ } }
    return r.reference ?? "—";
  };
  const desc = [...filtered].reverse();
  return {
    range: { from, to },
    kpis: { startBalance: r2(startBal), endBalance: r2(endBal), net: r2(endBal - startBal), inflow: { amount: inC / 100, count: inN, avg: inN ? r2(inC / 100 / inN) : 0 }, outflow: { amount: outC / 100, count: outN, avg: outN ? r2(outC / 100 / outN) : 0 } },
    series: { balance, flows },
    total: desc.length,
    page: q.page,
    size: q.size,
    items: desc.slice((q.page - 1) * q.size, q.page * q.size).map((r) => ({
      id: r.id, at: r.createdAt, type: r.type, category: CATEGORY[r.type] ?? "other", amount: Number(r.amount),
      balanceBefore: r2(Number(r.balanceAfter) - Number(r.amount)), balanceAfter: Number(r.balanceAfter), details: detail(r),
    })),
  };
}

/** Linha do tempo: cadastro, acessos, PIX, restrições, limites e ações da equipe. */
export async function userTimeline(id: string) {
  const u = await prisma.user.findUnique({ where: { id }, select: { createdAt: true } });
  if (!u) throw new AppError("Usuário não encontrado", 404, "NOT_FOUND");
  const [acts, pix, restr, limits, logs] = await Promise.all([
    prisma.userActivity.findMany({ where: { userId: id }, orderBy: { at: "desc" }, take: 60 }),
    prisma.pixOrder.findMany({ where: { userId: id }, orderBy: { createdAt: "desc" }, take: 100 }),
    prisma.userRestriction.findMany({ where: { userId: id } }),
    prisma.rgLimit.findMany({ where: { userId: id } }),
    prisma.adminAuditLog.findMany({ where: { target: id }, orderBy: { createdAt: "desc" }, take: 100 }),
  ]);
  const emails = await adminEmails(logs.map((l) => l.adminId));
  const brl = (v: unknown) => `R$ ${Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const ACTION_PT: Record<string, string> = {
    BALANCE_ADJUST: "Ajuste manual de saldo", USER_UPDATE: "Conta alterada pela equipe", TEST_FLAG: "Marcação de conta teste alterada",
    TEST_ACCOUNT_CREATE: "Conta teste criada", RESTRICTION_ADD: "Restrição aplicada pela equipe", RESTRICTION_EDIT: "Prazo da restrição editado",
    RESTRICTION_REVOKE: "Restrição retirada", RG_LIMIT_SET: "Limite de jogo responsável configurado", RG_LIMIT_REMOVE: "Limite de jogo responsável removido",
    WITHDRAW_LIMITS_SET: "Limite de saque individual alterado",
  };
  const ev: { at: Date; group: string; label: string; detail?: string; by?: string; tone: string }[] = [
    { at: u.createdAt, group: "Conta", label: "Cadastro criado", tone: "green" },
    ...acts.map((a) => ({ at: a.at, group: "Acesso", label: a.kind === "login" ? "Login" : a.kind === "register" ? "Primeiro acesso (cadastro)" : "Sessão ativa", detail: a.ip ?? undefined, tone: "gray" })),
    ...pix.flatMap((o) => [
      { at: o.createdAt, group: o.kind === "DEPOSIT" ? "Depósito" : "Saque", label: `${o.kind === "DEPOSIT" ? "Depósito" : "Saque"} solicitado · ${brl(o.amount)}`, tone: "gray" },
      ...(o.paidAt ? [{ at: o.paidAt, group: o.kind === "DEPOSIT" ? "Depósito" : "Saque", label: `${o.kind === "DEPOSIT" ? "Depósito concluído" : "Saque pago"} · ${brl(o.amount)}`, tone: "green" }] : []),
      ...(o.status === "FAILED" ? [{ at: o.createdAt, group: o.kind === "DEPOSIT" ? "Depósito" : "Saque", label: `${o.kind === "DEPOSIT" ? "Depósito" : "Saque"} recusado`, detail: o.note ?? undefined, tone: "red" }] : []),
    ]),
    ...restr.flatMap((r) => [
      { at: r.createdAt, group: "Proteção", label: `${KIND_PT[r.kind]} aplicada`, detail: r.reason, tone: "red" },
      ...(r.revokedAt ? [{ at: r.revokedAt, group: "Proteção", label: `${KIND_PT[r.kind]} retirada`, detail: r.revokeNote ?? undefined, tone: "green" }] : []),
    ]),
    ...limits.map((l) => ({ at: l.createdAt, group: "Proteção", label: `Limite ${l.kind} ${l.period} configurado`, detail: brl(l.amount), tone: "gray" })),
    ...logs.filter((l) => !["RESTRICTION_ADD", "RESTRICTION_REVOKE"].includes(l.action)).map((l) => ({ at: l.createdAt, group: "Equipe", label: ACTION_PT[l.action] ?? l.action, detail: l.payload ?? undefined, by: emails.get(l.adminId) ?? "equipe", tone: "blue" })),
  ];
  return { items: ev.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, 300) };
}

const deviceOf = (ua: string | null) => {
  if (!ua) return "—";
  const os = /Windows/i.test(ua) ? "Windows" : /Android/i.test(ua) ? "Android" : /iPhone|iPad|iOS/i.test(ua) ? "iOS" : /Mac OS/i.test(ua) ? "macOS" : /Linux/i.test(ua) ? "Linux" : "Outro";
  const br = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Navegador";
  return `${br} · ${os}`;
};

/** Segurança: acessos com IP e dispositivo, IPs compartilhados com outras contas. */
export async function userSecurity(id: string) {
  const acts = await prisma.userActivity.findMany({ where: { userId: id }, orderBy: { at: "desc" }, take: 200 });
  const ips = new Map<string, { count: number; lastAt: Date; device: string }>();
  for (const a of acts) {
    if (!a.ip) continue;
    const e = ips.get(a.ip) ?? { count: 0, lastAt: a.at, device: deviceOf(a.userAgent) };
    e.count++;
    ips.set(a.ip, e);
  }
  const publicIps = [...ips.keys()].filter((ip) => !isLocalIp(ip));
  const shared = publicIps.length
    ? await prisma.userActivity.groupBy({ by: ["userId", "ip"], where: { ip: { in: publicIps }, userId: { not: id } } })
    : [];
  const others = shared.length ? await prisma.user.findMany({ where: { id: { in: [...new Set(shared.map((s) => s.userId))] } }, select: { id: true, email: true } }) : [];
  return {
    mfa: { available: false },
    accesses: acts.slice(0, 50).map((a) => ({ at: a.at, kind: a.kind, ip: a.ip, device: deviceOf(a.userAgent) })),
    ips: [...ips].map(([ip, e]) => ({ ip, ...e, local: isLocalIp(ip) })),
    sharedIps: shared.map((s) => ({ ip: s.ip, userId: s.userId, email: others.find((o) => o.id === s.userId)?.email ?? s.userId })),
  };
}

/* ═════════════════════════ ações de proteção ═════════════════════════ */

export async function addRestriction(userId: string, input: { kind: string; reason: string; detail?: string | null; days?: number | null; scope?: string }, adminId: string) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!u) throw new AppError("Usuário não encontrado", 404, "NOT_FOUND");
  const scope = input.kind === "MANUAL_BLOCK" ? "TOTAL" : input.scope ?? "GAMING";
  const endsAt = input.days ? new Date(Date.now() + input.days * DAY) : null;
  return prisma.$transaction(async (tx) => {
    const r = await tx.userRestriction.create({ data: { userId, kind: input.kind, scope, reason: input.reason, detail: input.detail ?? null, endsAt, createdBy: adminId } });
    if (scope === "TOTAL") await tx.user.update({ where: { id: userId }, data: { isActive: false } });
    await tx.adminAuditLog.create({ data: { adminId, action: "RESTRICTION_ADD", target: userId, payload: JSON.stringify({ restrictionId: r.id, kind: r.kind, scope, reason: r.reason, endsAt }) } });
    return r;
  });
}

export async function editRestriction(id: string, endsAt: Date | null, adminId: string) {
  const r = await prisma.userRestriction.findUnique({ where: { id } });
  if (!r) throw new AppError("Restrição não encontrada", 404, "NOT_FOUND");
  if (r.revokedAt) throw new AppError("Essa restrição já foi retirada", 400, "ALREADY_REVOKED");
  await prisma.$transaction([
    prisma.userRestriction.update({ where: { id }, data: { endsAt, changedAt: new Date() } }),
    prisma.adminAuditLog.create({ data: { adminId, action: "RESTRICTION_EDIT", target: r.userId, payload: JSON.stringify({ restrictionId: id, before: r.endsAt, after: endsAt }) } }),
  ]);
  return { ok: true };
}

export async function revokeRestriction(id: string, note: string, adminId: string) {
  const r = await prisma.userRestriction.findUnique({ where: { id } });
  if (!r) throw new AppError("Restrição não encontrada", 404, "NOT_FOUND");
  if (r.revokedAt) throw new AppError("Essa restrição já foi retirada", 400, "ALREADY_REVOKED");
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.userRestriction.update({ where: { id }, data: { revokedAt: now, revokedBy: adminId, revokeNote: note, changedAt: now } });
    if (r.scope === "TOTAL") {
      const otherTotal = await tx.userRestriction.count({ where: { userId: r.userId, id: { not: id }, scope: "TOTAL", ...activeRestrictionWhere(now) } });
      if (!otherTotal) await tx.user.update({ where: { id: r.userId }, data: { isActive: true } });
    }
    await tx.adminAuditLog.create({ data: { adminId, action: "RESTRICTION_REVOKE", target: r.userId, payload: JSON.stringify({ restrictionId: id, kind: r.kind, note }) } });
  });
  return { ok: true };
}

/** Novo limite substitui o anterior do mesmo tipo e período. */
export async function addRgLimit(userId: string, input: { kind: string; period: string; amount: number }, adminId: string) {
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    await tx.rgLimit.updateMany({ where: { userId, kind: input.kind, period: input.period, removedAt: null }, data: { removedAt: now, removedBy: adminId } });
    const l = await tx.rgLimit.create({ data: { userId, kind: input.kind, period: input.period, amount: new Decimal(input.amount).toDecimalPlaces(2), createdBy: adminId } });
    await tx.adminAuditLog.create({ data: { adminId, action: "RG_LIMIT_SET", target: userId, payload: JSON.stringify({ limitId: l.id, ...input }) } });
    return l;
  });
}

export async function removeRgLimit(id: string, adminId: string) {
  const l = await prisma.rgLimit.findUnique({ where: { id } });
  if (!l || l.removedAt) throw new AppError("Limite não encontrado", 404, "NOT_FOUND");
  await prisma.$transaction([
    prisma.rgLimit.update({ where: { id }, data: { removedAt: new Date(), removedBy: adminId } }),
    prisma.adminAuditLog.create({ data: { adminId, action: "RG_LIMIT_REMOVE", target: l.userId, payload: JSON.stringify({ limitId: id, kind: l.kind, period: l.period }) } }),
  ]);
  return { ok: true };
}

export async function setUserWithdrawLimits(userId: string, lim: WithdrawLimits, adminId: string) {
  const before = await prisma.userWithdrawLimit.findUnique({ where: { userId } });
  const data = {
    maxPerWithdrawal: lim.maxPerWithdrawal == null ? null : new Decimal(lim.maxPerWithdrawal),
    dailyAmount: lim.dailyAmount == null ? null : new Decimal(lim.dailyAmount),
    dailyCount: lim.dailyCount,
    minIntervalMin: lim.minIntervalMin,
    updatedBy: adminId,
  };
  await prisma.$transaction([
    prisma.userWithdrawLimit.upsert({ where: { userId }, create: { userId, ...data }, update: data }),
    prisma.adminAuditLog.create({
      data: {
        adminId, action: "WITHDRAW_LIMITS_SET", target: userId,
        payload: JSON.stringify({ before: before ? { maxPerWithdrawal: num(before.maxPerWithdrawal), dailyAmount: num(before.dailyAmount), dailyCount: before.dailyCount, minIntervalMin: before.minIntervalMin } : null, after: lim }),
      },
    }),
  ]);
  return { ok: true };
}
