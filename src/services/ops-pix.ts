import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";
import { dayKey } from "./reports.js";
import { opsRange, dayList, cents, r2, pageArgs, userName } from "./ops-common.js";

/**
 * Depósitos e Saques (Operação): lista com filtros, KPIs do recorte, volume por dia e a fila de
 * "Ação necessária" (saques pendentes de aprovação manual).
 */

export interface PixListQuery {
  kind: "DEPOSIT" | "WITHDRAW";
  from?: string;
  to?: string;
  status?: "PENDING" | "PAID" | "FAILED" | "EXPIRED";
  gateway?: string;
  method?: string;
  currency?: string;
  q?: string;
  tab?: "all" | "action";
  page: number;
  size: number;
  sort: "date" | "amount";
  dir: "asc" | "desc";
  userId?: string;
}

function whereFor(q: PixListQuery, start: Date, end: Date): Prisma.PixOrderWhereInput {
  const search = q.q?.trim();
  return {
    kind: q.kind,
    ...(q.userId ? { userId: q.userId } : { user: { role: "PLAYER" } }),
    // "Ação necessária": todos os saques pendentes, independentemente do período e do status.
    ...(q.tab === "action" ? { status: "PENDING" } : { createdAt: { gte: start, lt: end }, ...(q.status ? { status: q.status } : {}) }),
    ...(q.gateway ? { gateway: q.gateway } : {}),
    ...(q.method ? { method: q.method } : {}),
    ...(q.currency ? { user: { role: "PLAYER", wallet: { is: { currency: q.currency } } } } : {}),
    ...(search
      ? {
          OR: [
            { id: { contains: search } },
            { txid: { contains: search } },
            { userId: { contains: search } },
            { pixKey: { contains: search } },
            { user: { email: { contains: search } } },
            { user: { displayName: { contains: search } } },
          ],
        }
      : {}),
  };
}

export async function pixList(q: PixListQuery) {
  const { from, to, start, end } = opsRange(q.from, q.to);
  const where = whereFor(q, start, end);
  const [groups, items, total, daily, actionCount, gateways] = await Promise.all([
    prisma.pixOrder.groupBy({ by: ["status"], where, _sum: { amount: true, fee: true }, _count: { _all: true } }),
    prisma.pixOrder.findMany({
      where,
      orderBy: q.sort === "amount" ? [{ amount: q.dir }, { createdAt: "desc" }] : { createdAt: q.dir },
      ...pageArgs(q.page, q.size),
      include: { user: { select: { id: true, email: true, displayName: true, isTest: true, cpf: true } } },
    }),
    prisma.pixOrder.count({ where }),
    q.tab === "action" ? Promise.resolve([]) : prisma.pixOrder.findMany({ where, select: { createdAt: true, amount: true, status: true }, take: 50_000 }),
    q.kind === "WITHDRAW" && !q.userId ? prisma.pixOrder.count({ where: { kind: "WITHDRAW", status: "PENDING", user: { role: "PLAYER" } } }) : Promise.resolve(0),
    prisma.pixOrder.groupBy({ by: ["gateway"], where: { kind: q.kind } }),
  ]);

  const g = (s: string) => groups.find((x) => x.status === s);
  const count = groups.reduce((s, x) => s + x._count._all, 0);
  const paidC = cents(g("PAID")?._sum.amount), feeC = cents(g("PAID")?._sum.fee);
  const paidN = g("PAID")?._count._all ?? 0;
  const decided = paidN + (g("FAILED")?._count._all ?? 0) + (g("EXPIRED")?._count._all ?? 0);
  const pendingC = cents(g("PENDING")?._sum.amount), pendingN = g("PENDING")?._count._all ?? 0;

  // Volume por dia (data do pedido): concluído em verde, demais status à parte.
  const days = dayList(from, to);
  const byDay = new Map(days.map((d) => [d, { paidC: 0, otherC: 0 }]));
  for (const r of daily) {
    const e = byDay.get(dayKey(r.createdAt));
    if (!e) continue;
    if (r.status === "PAID") e.paidC += cents(r.amount); else e.otherC += cents(r.amount);
  }

  return {
    range: { from, to },
    kpis: {
      totalPaid: paidC / 100,
      net: (paidC - feeC) / 100,
      fees: feeC / 100,
      count,
      paidCount: paidN,
      pendingAmount: pendingC / 100,
      pendingCount: pendingN,
      // Depósitos: concluídos ÷ todos. Saques: aprovados ÷ decididos (pendentes ficam de fora).
      rate: q.kind === "DEPOSIT" ? (count ? paidN / count : null) : decided ? paidN / decided : null,
      avgTicket: paidN ? r2(paidC / 100 / paidN) : 0,
    },
    daily: days.map((d) => ({ date: d, paid: byDay.get(d)!.paidC / 100, other: byDay.get(d)!.otherC / 100 })),
    actionCount,
    gateways: gateways.map((x) => x.gateway),
    total,
    page: q.page,
    size: q.size,
    items: items.map((o) => ({
      id: o.id,
      user: { id: o.user.id, name: userName(o.user), email: o.user.email, isTest: o.user.isTest },
      amount: Number(o.amount),
      fee: Number(o.fee),
      net: r2(Number(o.amount) - Number(o.fee)),
      status: o.status,
      gateway: o.gateway,
      method: o.method,
      pixKey: o.pixKey,
      pixKeyType: o.pixKeyType,
      reference: o.txid,
      note: o.note,
      createdAt: o.createdAt,
      paidAt: o.paidAt,
    })),
  };
}

/** Detalhe da ordem e a linha do tempo (criação, decisão e ações da equipe). */
export async function pixDetail(id: string) {
  const o = await prisma.pixOrder.findUnique({
    where: { id },
    include: { user: { select: { id: true, email: true, displayName: true, cpf: true, isTest: true, wallet: { select: { balance: true } } } } },
  });
  if (!o) throw new AppError("Ordem não encontrada", 404, "NOT_FOUND");
  const logs = await prisma.adminAuditLog.findMany({ where: { target: id }, orderBy: { createdAt: "asc" } });
  const admins = await prisma.user.findMany({ where: { id: { in: logs.map((l) => l.adminId) } }, select: { id: true, email: true } });
  const adminEmail = new Map(admins.map((a) => [a.id, a.email]));
  const timeline: { at: Date; label: string; by?: string; note?: string }[] = [
    { at: o.createdAt, label: o.kind === "DEPOSIT" ? "Depósito solicitado (PIX gerado)" : "Saque solicitado pelo jogador" },
  ];
  for (const l of logs) {
    const label = l.action === "PIX_APPROVE" ? (o.kind === "DEPOSIT" ? "Pagamento confirmado" : "Saque aprovado e pago")
      : l.action === "PIX_REJECT" ? "Recusado" : l.action;
    let note: string | undefined;
    try { note = l.payload ? JSON.parse(l.payload).reason : undefined; } catch { /* sem payload */ }
    timeline.push({ at: l.createdAt, label, by: adminEmail.get(l.adminId) ?? l.adminId, note });
  }
  if (o.status === "PAID" && !logs.some((l) => l.action === "PIX_APPROVE") && o.paidAt) timeline.push({ at: o.paidAt, label: "Pago" });
  return {
    id: o.id,
    kind: o.kind,
    status: o.status,
    amount: Number(o.amount),
    fee: Number(o.fee),
    net: r2(Number(o.amount) - Number(o.fee)),
    gateway: o.gateway,
    method: o.method,
    pixKey: o.pixKey,
    pixKeyType: o.pixKeyType,
    pixCopy: o.pixCopy,
    reference: o.txid,
    note: o.note,
    createdAt: o.createdAt,
    paidAt: o.paidAt,
    user: { id: o.user.id, name: userName(o.user), email: o.user.email, cpf: o.user.cpf, isTest: o.user.isTest, balance: Number(o.user.wallet?.balance ?? 0) },
    timeline: timeline.sort((a, b) => a.at.getTime() - b.at.getTime()),
  };
}
