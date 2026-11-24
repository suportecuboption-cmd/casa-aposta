import { prisma } from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";
import { assertCanReceiveRewards, creditBonus, isUniqueViolation, wageredTotal } from "./loyalty.js";

/**
 * Nível VIP (admin → Fidelidade → Nível VIP): o jogador sobe de nível pelo total apostado e, ao chegar
 * num nível com prêmio, resgata o bônus uma vez. Níveis e prêmios ficam no banco (SiteSetting "vip").
 */

const KEY = "vip";

export interface VipLevel {
  name: string;
  minWagered: number; // total apostado para chegar ao nível (R$)
  reward: number; // bônus ao chegar (R$; 0 = sem bônus)
  color: string; // cor do selo
  perks: string; // benefícios em texto livre (opcional)
}
export interface VipConfig {
  enabled: boolean;
  levels: VipLevel[];
  updatedAt: string | null;
  updatedBy: string | null;
}

export const DEFAULT_VIP_LEVELS: VipLevel[] = [
  { name: "Bronze", minWagered: 0, reward: 0, color: "#c8793a", perks: "" },
  { name: "Prata", minWagered: 1000, reward: 10, color: "#8f9aab", perks: "" },
  { name: "Ouro", minWagered: 5000, reward: 50, color: "#d99a00", perks: "" },
  { name: "Platina", minWagered: 20000, reward: 200, color: "#3fa7b5", perks: "" },
  { name: "Diamante", minWagered: 100000, reward: 1000, color: "#5b7cff", perks: "" },
];

const r2 = (v: number) => Math.round(v * 100) / 100;
const COLOR = /^#[0-9a-f]{6}$/i;
export const levelKey = (name: string) => name.trim().toLowerCase();

/** Pura: limpa e ordena os níveis (menor total primeiro; nomes repetidos saem). */
export function normalizeLevels(levels: Partial<VipLevel>[]): VipLevel[] {
  const seen = new Set<string>();
  const out: VipLevel[] = [];
  for (const l of levels) {
    const name = String(l.name ?? "").trim().slice(0, 24);
    if (!name || seen.has(levelKey(name))) continue;
    seen.add(levelKey(name));
    out.push({
      name,
      minWagered: r2(Math.max(0, Number(l.minWagered) || 0)),
      reward: r2(Math.max(0, Number(l.reward) || 0)),
      color: COLOR.test(String(l.color ?? "")) ? String(l.color) : "#8f9aab",
      perks: String(l.perks ?? "").trim().slice(0, 200),
    });
  }
  return out.sort((a, b) => a.minWagered - b.minWagered);
}

/** Pura: em que nível o jogador está, qual é o próximo e quanto falta. */
export function vipStatus(levels: VipLevel[], wagered: number) {
  let current = -1;
  levels.forEach((l, i) => { if (wagered >= l.minWagered) current = i; });
  const next = current + 1 < levels.length ? current + 1 : null;
  const from = current >= 0 ? levels[current].minWagered : 0;
  const to = next !== null ? levels[next].minWagered : null;
  const progress = to === null ? 1 : to > from ? Math.min(1, Math.max(0, (wagered - from) / (to - from))) : 1;
  return { current, next, progress: Math.round(progress * 1000) / 1000, toNext: to === null ? 0 : r2(Math.max(0, to - wagered)) };
}

const defaults = (): VipConfig => ({ enabled: true, levels: DEFAULT_VIP_LEVELS.map((l) => ({ ...l })), updatedAt: null, updatedBy: null });

/** Pura: lê o JSON gravado (quebrado = padrão). */
export function parseVip(value: string | null | undefined): VipConfig {
  const d = defaults();
  if (!value) return d;
  try {
    const j = JSON.parse(value);
    if (!j || typeof j !== "object") return d;
    const levels = Array.isArray(j.levels) ? normalizeLevels(j.levels) : d.levels;
    return {
      enabled: typeof j.enabled === "boolean" ? j.enabled : d.enabled,
      levels: levels.length ? levels : d.levels,
      updatedAt: typeof j.updatedAt === "string" ? j.updatedAt : null,
      updatedBy: typeof j.updatedBy === "string" ? j.updatedBy : null,
    };
  } catch {
    return d;
  }
}

export async function getVipConfig(): Promise<VipConfig> {
  const row = await prisma.siteSetting.findUnique({ where: { key: KEY } });
  return parseVip(row?.value);
}

export async function saveVipConfig(input: { enabled: boolean; levels: Partial<VipLevel>[] }, adminId: string) {
  const levels = normalizeLevels(input.levels);
  if (!levels.length) throw new AppError("Cadastre pelo menos um nível", 400, "VALIDATION");
  const cfg: VipConfig = { enabled: input.enabled, levels, updatedAt: new Date().toISOString(), updatedBy: adminId };
  const value = JSON.stringify(cfg);
  await prisma.$transaction([
    prisma.siteSetting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } }),
    prisma.adminAuditLog.create({ data: { adminId, action: "VIP_CONFIG", target: KEY, payload: JSON.stringify({ enabled: cfg.enabled, levels: levels.map((l) => `${l.name}≥${l.minWagered}:${l.reward}`) }) } }),
  ]);
  return cfg;
}

/** O que o jogador vê (sem login: só os níveis). */
export async function playerVip(userId: string | null) {
  const cfg = await getVipConfig();
  const base = { enabled: cfg.enabled, levels: cfg.levels.map((l) => ({ ...l, reached: false, claimed: false })) };
  if (!userId) return { ...base, loggedIn: false, wagered: 0, current: -1, next: cfg.levels.length ? 0 : null, progress: 0, toNext: cfg.levels[0]?.minWagered ?? 0 };
  const [wagered, claims] = await Promise.all([
    wageredTotal(userId),
    prisma.vipReward.findMany({ where: { userId }, select: { level: true } }),
  ]);
  const claimed = new Set(claims.map((c) => c.level));
  const st = vipStatus(cfg.levels, wagered);
  return {
    ...base,
    loggedIn: true,
    wagered,
    ...st,
    levels: cfg.levels.map((l) => ({ ...l, reached: wagered >= l.minWagered, claimed: claimed.has(levelKey(l.name)) })),
  };
}

/** Resgata o bônus de um nível já alcançado (uma vez por nível). */
export async function claimVipReward(userId: string, levelName: string) {
  const cfg = await getVipConfig();
  if (!cfg.enabled) throw new AppError("O programa VIP está desligado no momento.", 409, "VIP_DISABLED");
  const level = cfg.levels.find((l) => levelKey(l.name) === levelKey(levelName));
  if (!level) throw new AppError("Nível não encontrado", 404, "NOT_FOUND");
  if (level.reward <= 0) throw new AppError("Esse nível não tem bônus para resgatar.", 409, "NO_REWARD");
  await assertCanReceiveRewards(userId);
  const wagered = await wageredTotal(userId);
  if (wagered < level.minWagered) throw new AppError(`Você ainda não chegou ao nível ${level.name}.`, 409, "LEVEL_NOT_REACHED");
  try {
    const balance = await prisma.$transaction(async (tx) => {
      await tx.vipReward.create({ data: { userId, level: levelKey(level.name), amount: level.reward } });
      return creditBonus(tx, userId, level.reward, `vip:${levelKey(level.name)}`, { source: "vip", level: level.name });
    });
    return { ok: true, level: level.name, amount: level.reward, balance };
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError("Você já resgatou o bônus desse nível.", 409, "ALREADY_CLAIMED");
    throw e;
  }
}

export async function vipAdminView() {
  const [cfg, agg] = await Promise.all([
    getVipConfig(),
    prisma.vipReward.groupBy({ by: ["level"], _count: { _all: true }, _sum: { amount: true } }),
  ]);
  const by = cfg.updatedBy ? await prisma.user.findUnique({ where: { id: cfg.updatedBy }, select: { email: true } }) : null;
  return {
    ...cfg,
    updatedByEmail: by?.email ?? null,
    claims: agg.map((a) => ({ level: a.level, count: a._count._all, total: Number(a._sum.amount ?? 0) })),
  };
}
