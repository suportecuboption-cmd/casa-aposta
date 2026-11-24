import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";
import { dayKey } from "./reports.js";

/**
 * Proteção do jogador (jogo responsável): autoexclusão, suspensão e bloqueio manual, limites de
 * jogo responsável e limites de saque. As regras ficam em funções puras (testadas); os "guards"
 * aplicam essas regras nas rotas de aposta, depósito e saque.
 */

export type AccessMode = "OPERATIONAL" | "WITHDRAW_ONLY" | "BLOCKED";
export interface RestrictionLike {
  kind: string;
  scope: string;
  startsAt: Date;
  endsAt: Date | null;
  revokedAt: Date | null;
}

export const KIND_PT: Record<string, string> = {
  SELF_EXCLUSION: "Autoexclusão",
  SUSPENSION: "Suspensão",
  MANUAL_BLOCK: "Bloqueio manual",
};

/** Vale agora: não retirada, já começou e (sem prazo ou prazo no futuro). */
export function restrictionActive(r: RestrictionLike, now = new Date()) {
  return !r.revokedAt && r.startsAt <= now && (!r.endsAt || r.endsAt > now);
}

/** Modo de acesso: conta inativa ou restrição TOTAL bloqueia tudo; qualquer outra deixa só sacar. */
export function accessMode(userActive: boolean, restrictions: RestrictionLike[], now = new Date()): AccessMode {
  if (!userActive) return "BLOCKED";
  const active = restrictions.filter((r) => restrictionActive(r, now));
  if (active.some((r) => r.scope === "TOTAL")) return "BLOCKED";
  return active.length ? "WITHDRAW_ONLY" : "OPERATIONAL";
}

/* ───────────── janelas dos limites (fuso de São Paulo) ───────────── */

export type Period = "DAY" | "WEEK" | "MONTH";
export const PERIOD_PT: Record<Period, string> = { DAY: "diário", WEEK: "semanal", MONTH: "mensal" };

/** Início da janela atual: hoje 00:00, segunda-feira 00:00 ou dia 1 00:00 (São Paulo). */
export function periodStart(period: Period, now = new Date()): Date {
  const ymd = dayKey(now);
  if (period === "DAY") return new Date(`${ymd}T00:00:00-03:00`);
  if (period === "MONTH") return new Date(`${ymd.slice(0, 8)}01T00:00:00-03:00`);
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // volta até segunda
  return new Date(`${d.toISOString().slice(0, 10)}T00:00:00-03:00`);
}

/** O valor novo cabe no limite? (centavos de folga para ruído de ponto flutuante) */
export const fitsLimit = (limit: number, used: number, add: number) => used + add <= limit + 0.005;

/* ───────────── limites de saque ───────────── */

export interface WithdrawLimits {
  maxPerWithdrawal: number | null;
  dailyAmount: number | null;
  dailyCount: number | null;
  minIntervalMin: number | null;
}
export const WITHDRAW_KEYS = ["maxPerWithdrawal", "dailyAmount", "dailyCount", "minIntervalMin"] as const;
export const DEFAULT_HOUSE_WITHDRAW: WithdrawLimits = { maxPerWithdrawal: 10000, dailyAmount: 10000, dailyCount: null, minIntervalMin: null };

/** Campo individual preenchido vence o da casa; vazio herda. */
export function effectiveWithdrawLimits(house: WithdrawLimits, individual: Partial<WithdrawLimits> | null) {
  const out = {} as WithdrawLimits;
  const source = {} as Record<(typeof WITHDRAW_KEYS)[number], "house" | "individual">;
  for (const k of WITHDRAW_KEYS) {
    const own = individual?.[k];
    out[k] = own ?? house[k];
    source[k] = own == null ? "house" : "individual";
  }
  return { limits: out, source };
}

const brl = (v: number) => `R$ ${v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Pura: devolve o motivo da recusa do saque ou null se pode. */
export function checkWithdraw(
  lim: WithdrawLimits,
  s: { amount: number; todaySum: number; todayCount: number; lastAt: Date | null; now: Date },
): string | null {
  if (lim.maxPerWithdrawal != null && s.amount > lim.maxPerWithdrawal + 0.005) return `O máximo por saque é ${brl(lim.maxPerWithdrawal)}.`;
  if (lim.dailyAmount != null && !fitsLimit(lim.dailyAmount, s.todaySum, s.amount)) {
    return `Limite diário de saque: ${brl(lim.dailyAmount)} (já pedidos hoje: ${brl(s.todaySum)}).`;
  }
  if (lim.dailyCount != null && s.todayCount + 1 > lim.dailyCount) return `Limite de ${lim.dailyCount} saque(s) por dia atingido.`;
  if (lim.minIntervalMin != null && s.lastAt) {
    const waitMs = s.lastAt.getTime() + lim.minIntervalMin * 60_000 - s.now.getTime();
    if (waitMs > 0) return `Aguarde ${Math.ceil(waitMs / 60_000)} min para pedir outro saque.`;
  }
  return null;
}

const HOUSE_KEY = "houseWithdrawLimits";
export async function getHouseWithdrawLimits(): Promise<WithdrawLimits> {
  const row = await prisma.siteSetting.findUnique({ where: { key: HOUSE_KEY } });
  if (!row) return DEFAULT_HOUSE_WITHDRAW;
  try { return { ...DEFAULT_HOUSE_WITHDRAW, ...JSON.parse(row.value) }; } catch { return DEFAULT_HOUSE_WITHDRAW; }
}
export async function saveHouseWithdrawLimits(lim: WithdrawLimits, adminId: string) {
  const before = await getHouseWithdrawLimits();
  const value = JSON.stringify(lim);
  await prisma.$transaction([
    prisma.siteSetting.upsert({ where: { key: HOUSE_KEY }, create: { key: HOUSE_KEY, value }, update: { value } }),
    prisma.adminAuditLog.create({ data: { adminId, action: "HOUSE_WITHDRAW_LIMITS", target: HOUSE_KEY, payload: JSON.stringify({ before, after: lim }) } }),
  ]);
  return lim;
}

/* ───────────── carregamento e guards ───────────── */

const num = (v: unknown) => (v == null ? null : Number(v));

export async function loadProtection(userId: string) {
  const [user, restrictions, limits] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { isActive: true } }),
    prisma.userRestriction.findMany({ where: { userId }, orderBy: { createdAt: "desc" } }),
    prisma.rgLimit.findMany({ where: { userId, removedAt: null }, orderBy: { createdAt: "asc" } }),
  ]);
  if (!user) throw new AppError("Usuário não encontrado", 404, "NOT_FOUND");
  return { mode: accessMode(user.isActive, restrictions), restrictions, limits };
}

function modeError(mode: AccessMode, restrictions: RestrictionLike[]) {
  if (mode === "BLOCKED") return new AppError("Conta bloqueada. Fale com o suporte.", 403, "PLAYER_BLOCKED");
  const r = restrictions.find((x) => restrictionActive(x));
  const until = r?.endsAt ? ` até ${r.endsAt.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })}` : "";
  const what = r ? KIND_PT[r.kind]?.toLowerCase() ?? "restrição" : "restrição";
  return new AppError(`Sua conta está em ${what}${until}. Só saques estão liberados.`, 403, "PLAYER_RESTRICTED");
}

/** Depósito: só com a conta operacional e dentro do limite de depósito. */
export async function guardDeposit(userId: string, amount: number) {
  const { mode, restrictions, limits } = await loadProtection(userId);
  if (mode !== "OPERATIONAL") throw modeError(mode, restrictions);
  for (const l of limits.filter((x) => x.kind === "DEPOSIT")) {
    const since = periodStart(l.period as Period);
    const agg = await prisma.pixOrder.aggregate({
      where: { userId, kind: "DEPOSIT", status: { in: ["PENDING", "PAID"] }, createdAt: { gte: since } },
      _sum: { amount: true },
    });
    const used = Number(agg._sum.amount ?? 0), limit = Number(l.amount);
    if (!fitsLimit(limit, used, amount)) {
      throw new AppError(`Limite ${PERIOD_PT[l.period as Period]} de depósito: ${brl(limit)} (já usado: ${brl(used)}).`, 403, "RG_LIMIT");
    }
  }
}

/** Aposta (esporte ou cassino): conta operacional e dentro dos limites de aposta e de perda. */
export async function guardPlay(userId: string, stake: number) {
  const { mode, restrictions, limits } = await loadProtection(userId);
  if (mode !== "OPERATIONAL") throw modeError(mode, restrictions);
  const relevant = limits.filter((x) => x.kind === "BET" || x.kind === "LOSS");
  if (!relevant.length) return;
  const wallet = await prisma.wallet.findUnique({ where: { userId }, select: { id: true } });
  if (!wallet) return;
  for (const l of relevant) {
    const since = periodStart(l.period as Period);
    const groups = await prisma.walletTransaction.groupBy({
      by: ["type"],
      where: { walletId: wallet.id, createdAt: { gte: since }, type: { in: ["BET_STAKE", "CASINO_BET", "BET_WIN", "CASINO_WIN", "BET_REFUND", "CASINO_REFUND"] } },
      _sum: { amount: true },
    });
    const sum = (types: string[]) => groups.filter((g) => types.includes(g.type)).reduce((s, g) => s + Number(g._sum.amount ?? 0), 0);
    const staked = -sum(["BET_STAKE", "CASINO_BET"]);
    const returned = sum(["BET_WIN", "CASINO_WIN", "BET_REFUND", "CASINO_REFUND"]);
    const used = l.kind === "BET" ? staked : Math.max(0, staked - returned);
    const limit = Number(l.amount);
    if (!fitsLimit(limit, used, stake)) {
      const label = l.kind === "BET" ? "valor apostado" : "perda líquida";
      throw new AppError(`Limite ${PERIOD_PT[l.period as Period]} de ${label}: ${brl(limit)} (já usado: ${brl(used)}).`, 403, "RG_LIMIT");
    }
  }
}

/* ───────────── autosserviço do jogador (Jogo responsável) ───────────── */

/** Situação de proteção para o próprio jogador: modo, autoexclusão e limites ativos. */
export async function playerProtection(userId: string, now = new Date()) {
  const [user, restrictions, limits] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { isActive: true } }),
    prisma.userRestriction.findMany({ where: { userId }, orderBy: { createdAt: "desc" } }),
    prisma.rgLimit.findMany({ where: { userId, removedAt: null }, orderBy: [{ kind: "asc" }, { period: "asc" }] }),
  ]);
  if (!user) throw new AppError("Usuário não encontrado", 404, "NOT_FOUND");
  const mode = accessMode(user.isActive, restrictions, now);
  const selfExcl = restrictions.find((r) => r.kind === "SELF_EXCLUSION" && restrictionActive(r, now));
  const staff = restrictions.find((r) => r.kind !== "SELF_EXCLUSION" && restrictionActive(r, now));
  return {
    mode,
    selfExclusion: selfExcl ? { startsAt: selfExcl.startsAt, endsAt: selfExcl.endsAt } : null,
    staffRestriction: staff ? { kind: staff.kind, kindPt: KIND_PT[staff.kind], endsAt: staff.endsAt } : null,
    limits: limits.map((l) => ({ id: l.id, kind: l.kind, period: l.period, amount: Number(l.amount), self: !l.createdBy })),
  };
}

/** Jogador define/atualiza o próprio limite (substitui o do mesmo tipo e período). createdBy null = jogador. */
export async function playerSetLimit(userId: string, input: { kind: string; period: string; amount: number }) {
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.rgLimit.updateMany({ where: { userId, kind: input.kind, period: input.period, removedAt: null }, data: { removedAt: now } });
    await tx.rgLimit.create({ data: { userId, kind: input.kind, period: input.period, amount: new Decimal(input.amount).toDecimalPlaces(2), createdBy: null } });
  });
  return { ok: true };
}

/** Jogador remove um limite — só os que ele mesmo definiu (os da equipe ficam travados). */
export async function playerRemoveLimit(userId: string, id: string) {
  const l = await prisma.rgLimit.findUnique({ where: { id } });
  if (!l || l.userId !== userId || l.removedAt) throw new AppError("Limite não encontrado", 404, "NOT_FOUND");
  if (l.createdBy) throw new AppError("Esse limite foi definido pela equipe; só a equipe pode remover.", 403, "LIMIT_LOCKED");
  await prisma.rgLimit.update({ where: { id }, data: { removedAt: new Date() } });
  return { ok: true };
}

/** Autoexclusão pedida pelo jogador: bloqueia depósito/aposta (só saque) por um prazo (ou sem prazo). Não pode ser retirada pelo próprio jogador. */
export async function playerSelfExclude(userId: string, days: number | null) {
  const now = new Date();
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) throw new AppError("Usuário não encontrado", 404, "NOT_FOUND");
  const existing = await prisma.userRestriction.findFirst({
    where: { userId, kind: "SELF_EXCLUSION", revokedAt: null, OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
  });
  if (existing) throw new AppError("Você já está em autoexclusão.", 400, "ALREADY_EXCLUDED");
  const endsAt = days ? new Date(now.getTime() + days * 86_400_000) : null;
  await prisma.userRestriction.create({
    data: { userId, kind: "SELF_EXCLUSION", scope: "GAMING", reason: "Autoexclusão solicitada pelo jogador", endsAt, createdBy: null },
  });
  return { ok: true, endsAt };
}

/** Saque: bloqueado só para conta bloqueada; respeita os limites (individual ou da casa). */
export async function guardWithdraw(userId: string, amount: number) {
  const { mode, restrictions } = await loadProtection(userId);
  if (mode === "BLOCKED") throw modeError(mode, restrictions);
  const [house, own, today, last] = await Promise.all([
    getHouseWithdrawLimits(),
    prisma.userWithdrawLimit.findUnique({ where: { userId } }),
    prisma.pixOrder.aggregate({
      where: { userId, kind: "WITHDRAW", status: { in: ["PENDING", "PAID"] }, createdAt: { gte: periodStart("DAY") } },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.pixOrder.findFirst({ where: { userId, kind: "WITHDRAW", status: { in: ["PENDING", "PAID"] } }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
  ]);
  const individual = own
    ? { maxPerWithdrawal: num(own.maxPerWithdrawal), dailyAmount: num(own.dailyAmount), dailyCount: own.dailyCount, minIntervalMin: own.minIntervalMin }
    : null;
  const { limits } = effectiveWithdrawLimits(house, individual);
  const err = checkWithdraw(limits, {
    amount,
    todaySum: Number(today._sum.amount ?? 0),
    todayCount: today._count._all,
    lastAt: last?.createdAt ?? null,
    now: new Date(),
  });
  if (err) throw new AppError(err, 400, "WITHDRAW_LIMIT");
}
