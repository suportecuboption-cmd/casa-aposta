import { prisma } from "../lib/prisma.js";
import { dayKey } from "./reports.js";
import { getDashboardParams } from "./dashboard.js";
import { brandConfig } from "./brand.js";

/**
 * Faturas: demonstrativo mensal (competência) do custo cobrado pelo agregador sobre o GGR de
 * cada provedor. Custo do provedor no mês = GGR positivo × % de custo (GGR negativo não gera
 * custo e fica sinalizado). Semanas 1–4 = dias 1–7, 8–14, 15–21, 22–28; semana 5 = 29 até o
 * fim. O custo por semana/dia soma GGR × % sem piso (pode ficar negativo, como no Axio).
 */

const OFFSET = "-03:00";
const SPORTSBOOK = "Sportsbook";

export const monthOf = (d: Date) => dayKey(d).slice(0, 7);
export function monthRange(month: string) {
  const [y, m] = month.split("-").map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  return { start: new Date(`${month}-01T00:00:00${OFFSET}`), end: new Date(`${next}-01T00:00:00${OFFSET}`) };
}
export function monthDays(month: string) {
  const [y, m] = month.split("-").map(Number);
  const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
}
export function monthWeeks(month: string) {
  const days = monthDays(month);
  const weeks: { n: number; days: string[] }[] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push({ n: weeks.length + 1, days: days.slice(i, i + 7) });
  return weeks;
}

export interface ProviderDay { provider: string; day: string; ggrC: number }

/** Pura: monta o demonstrativo a partir do GGR por provedor e dia (centavos). */
export function buildInvoice(month: string, rows: ProviderDay[], pctOf: (provider: string) => number | null) {
  const byProv = new Map<string, number>();
  for (const r of rows) byProv.set(r.provider, (byProv.get(r.provider) ?? 0) + r.ggrC);
  const providers = [...byProv].map(([name, ggrC]) => {
    const pct = pctOf(name);
    const costC = pct == null ? null : Math.round((Math.max(0, ggrC) * pct) / 100);
    return { name, ggr: ggrC / 100, pct, cost: costC == null ? null : costC / 100, negative: ggrC < 0 };
  }).sort((a, b) => b.ggr - a.ggr);
  const dayCost = (day: string) => rows.filter((r) => r.day === day).reduce((s, r) => {
    const pct = pctOf(r.provider);
    return pct == null ? s : s + (r.ggrC * pct) / 100;
  }, 0);
  const weeks = monthWeeks(month).map((w) => {
    const days = w.days.map((day) => ({ day, cost: Math.round(dayCost(day)) / 100 }));
    return { n: w.n, from: w.days[0], to: w.days[w.days.length - 1], cost: Math.round(days.reduce((s, d) => s + d.cost * 100, 0)) / 100, days };
  });
  const totalGgr = Math.round(providers.reduce((s, p) => s + p.ggr * 100, 0)) / 100;
  const totalCost = Math.round(providers.reduce((s, p) => s + (p.cost ?? 0) * 100, 0)) / 100;
  const missingPct = providers.some((p) => p.pct == null);
  return { providers, totalGgr, totalCost, weeks, missingPct };
}

/** Pura: situação da fatura. */
export function invoiceStatus(month: string, currentMonth: string, total: number, paid: number) {
  if (month === currentMonth) return paid > 0 ? "Parcial · pagamento parcial" : "Parcial publicado";
  if (total <= 0) return "Sem custo";
  if (paid >= total - 0.005) return "Pago";
  return paid > 0 ? "Pagamento parcial" : "Em aberto";
}

/* ───────────── parâmetros da fatura ───────────── */

export interface InvoiceParams { issuer: string; defaultPct: number | null; providers: Record<string, number> }
const PARAMS_KEY = "invoiceParams";
export const DEFAULT_INVOICE_PARAMS: InvoiceParams = { issuer: "PlayFivers", defaultPct: null, providers: {} };

export async function getInvoiceParams(): Promise<InvoiceParams> {
  const row = await prisma.siteSetting.findUnique({ where: { key: PARAMS_KEY } });
  if (!row) return DEFAULT_INVOICE_PARAMS;
  try { return { ...DEFAULT_INVOICE_PARAMS, ...JSON.parse(row.value) }; } catch { return DEFAULT_INVOICE_PARAMS; }
}
export async function saveInvoiceParams(p: InvoiceParams, adminId: string) {
  const before = await getInvoiceParams();
  const value = JSON.stringify(p);
  await prisma.$transaction([
    prisma.siteSetting.upsert({ where: { key: PARAMS_KEY }, create: { key: PARAMS_KEY, value }, update: { value } }),
    prisma.adminAuditLog.create({ data: { adminId, action: "INVOICE_PARAMS_UPDATE", target: PARAMS_KEY, payload: JSON.stringify({ before, after: p }) } }),
  ]);
  return p;
}
const pctResolver = (p: InvoiceParams) => (provider: string) => {
  const own = Object.entries(p.providers).find(([k]) => k.toLowerCase() === provider.toLowerCase());
  return own ? own[1] : p.defaultPct;
};

/* ───────────── consultas ───────────── */

const PLAY = ["CASINO_BET", "CASINO_WIN", "CASINO_REFUND", "BET_STAKE", "BET_WIN", "BET_REFUND"] as const;

/** GGR por provedor e dia num intervalo (centavos). Esportes entram como "Sportsbook". */
async function providerDays(start: Date, end: Date): Promise<ProviderDay[]> {
  const rows = await prisma.walletTransaction.findMany({
    where: { createdAt: { gte: start, lt: end }, type: { in: [...PLAY] }, wallet: { user: { role: "PLAYER", isTest: false } } },
    select: { type: true, amount: true, createdAt: true, game: { select: { provider: { select: { name: true } } } } },
  });
  const map = new Map<string, ProviderDay>();
  for (const r of rows) {
    const provider = r.type.startsWith("BET_") ? SPORTSBOOK : r.game?.provider.name ?? "Sem provedor";
    const day = dayKey(r.createdAt);
    const k = provider + "|" + day;
    const e = map.get(k) ?? map.set(k, { provider, day, ggrC: 0 }).get(k)!;
    e.ggrC -= Math.round(Number(r.amount) * 100); // GGR = −(aposta negativa + prêmios/estornos positivos)
  }
  // Rodadas pagas com saldo de bônus (incentivos): o agregador cobra sobre a aposta inteira, então entram na fatura.
  const bonusRows = await prisma.bonusTransaction.findMany({
    where: { createdAt: { gte: start, lt: end }, type: { in: ["BET", "WIN", "REFUND"] }, gameId: { not: null }, incentive: { user: { role: "PLAYER", isTest: false } } },
    select: { amount: true, createdAt: true, game: { select: { provider: { select: { name: true } } } } },
  });
  for (const r of bonusRows) {
    if (!Number(r.amount)) continue;
    const provider = r.game?.provider.name ?? "Sem provedor";
    const day = dayKey(r.createdAt);
    const k = provider + "|" + day;
    const e = map.get(k) ?? map.set(k, { provider, day, ggrC: 0 }).get(k)!;
    e.ggrC -= Math.round(Number(r.amount) * 100);
  }
  return [...map.values()];
}

async function totalsFor(month: string, p: InvoiceParams) {
  const { start, end } = monthRange(month);
  return buildInvoice(month, await providerDays(start, end), pctResolver(p));
}

export async function invoiceMonths() {
  const [first, payments, params] = await Promise.all([
    prisma.walletTransaction.findFirst({ where: { type: { in: [...PLAY] } }, orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
    prisma.invoicePayment.groupBy({ by: ["month"], _sum: { amount: true } }),
    getInvoiceParams(),
  ]);
  const current = monthOf(new Date());
  const months: string[] = [];
  let m = first ? monthOf(first.createdAt) : current;
  while (m <= current && months.length < 24) {
    months.push(m);
    const [y, mm] = m.split("-").map(Number);
    m = mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, "0")}`;
  }
  const paidBy = new Map(payments.map((x) => [x.month, Number(x._sum.amount ?? 0)]));
  const out = [];
  for (const month of months.reverse()) {
    const inv = await totalsFor(month, params);
    const paid = paidBy.get(month) ?? 0;
    out.push({ month, total: inv.totalCost, paid, due: Math.round((inv.totalCost - paid) * 100) / 100, status: invoiceStatus(month, current, inv.totalCost, paid), missingPct: inv.missingPct });
  }
  return { current, months: out };
}

export async function invoiceDetail(month: string) {
  const [params, dash, payments] = await Promise.all([
    getInvoiceParams(),
    getDashboardParams(),
    prisma.invoicePayment.findMany({ where: { month }, orderBy: { paidAt: "asc" } }),
  ]);
  const inv = await totalsFor(month, params);
  const paid = payments.reduce((s, x) => s + Number(x.amount), 0);
  const due = Math.round((inv.totalCost - paid) * 100) / 100;
  const usd = (v: number) => (dash.usdBrlRate ? Math.round((v / dash.usdBrlRate) * 100) / 100 : null);
  const { start, end } = monthRange(month);
  return {
    month,
    period: { from: dayKey(start), to: dayKey(new Date(end.getTime() - 1)) },
    status: invoiceStatus(month, monthOf(new Date()), inv.totalCost, paid),
    issuer: params.issuer,
    taker: brandConfig().name,
    ...inv,
    paid: Math.round(paid * 100) / 100,
    due,
    usd: { total: usd(inv.totalCost), paid: usd(paid), due: usd(due) },
    payments: payments.map((x) => ({ id: x.id, amount: Number(x.amount), paidAt: x.paidAt, note: x.note })),
    params,
  };
}
