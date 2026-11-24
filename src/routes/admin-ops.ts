import type { FastifyInstance } from "fastify";
import { Role } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";
import { idParamSchema } from "../schemas/index.js";

/** Operação do dia a dia: jogadores, financeiro (PIX), bilhetes e auditoria. */

const staff: Role[] = [Role.ADMIN, Role.FINANCE, Role.SUPPORT];
const finance: Role[] = [Role.ADMIN, Role.FINANCE];

const usersQuery = z.object({
  q: z.string().trim().max(80).optional(),
  role: z.nativeEnum(Role).optional(),
  status: z.enum(["active", "blocked"]).optional(),
});
const adjustSchema = z.object({
  amount: z
    .number({ invalid_type_error: "Informe o valor" })
    .refine((v) => v !== 0, "O valor não pode ser zero")
    .refine((v) => Math.abs(v) <= 1_000_000, "Valor alto demais"),
  reason: z.string().trim().min(3, "Explique o motivo do ajuste").max(200),
});
const pixQuery = z.object({
  status: z.enum(["PENDING", "PAID", "FAILED", "EXPIRED"]).optional(),
  kind: z.enum(["DEPOSIT", "WITHDRAW"]).optional(),
  q: z.string().trim().max(80).optional(),
});
const rejectSchema = z.object({ reason: z.string().trim().min(3, "Explique o motivo da recusa").max(200) });
const betsQuery = z.object({
  status: z.enum(["OPEN", "WON", "LOST", "VOID", "CASHED_OUT"]).optional(),
  q: z.string().trim().max(80).optional(),
});
const auditQuery = z.object({ action: z.string().max(40).optional(), q: z.string().trim().max(80).optional() });

const r2 = (v: number) => Math.round(v * 100) / 100;
const emptyTotals = () => ({ deposited: 0, withdrawn: 0, staked: 0, refunded: 0, won: 0, adjustments: 0, bets: 0, rounds: 0, ggr: 0 });
type Totals = ReturnType<typeof emptyTotals>;

/** Totais por carteira a partir do razão. GGR do jogador para a casa = (apostado − devolvido) − ganho. */
async function walletTotals(walletIds: string[]) {
  const map = new Map<string, Totals>();
  if (!walletIds.length) return map;
  const groups = await prisma.walletTransaction.groupBy({
    by: ["walletId", "type"],
    where: { walletId: { in: walletIds } },
    _sum: { amount: true },
    _count: { _all: true },
  });
  for (const g of groups) {
    const t = map.get(g.walletId) ?? emptyTotals();
    const v = Number(g._sum.amount ?? 0);
    switch (g.type) {
      case "DEPOSIT": t.deposited += v; break;
      case "WITHDRAW": t.withdrawn -= v; break;
      case "BET_STAKE": t.staked -= v; t.bets += g._count._all; break;
      case "CASINO_BET": t.staked -= v; t.rounds += g._count._all; break;
      case "BET_WIN": case "CASINO_WIN": t.won += v; break;
      case "BET_REFUND": case "CASINO_REFUND": t.refunded += v; break;
      case "ADJUSTMENT": case "BONUS": t.adjustments += v; break;
    }
    map.set(g.walletId, t);
  }
  for (const t of map.values()) {
    for (const k of Object.keys(t) as (keyof Totals)[]) t[k] = r2(t[k]);
    t.ggr = r2(t.staked - t.refunded - t.won);
  }
  return map;
}

export async function adminOpsRoutes(app: FastifyInstance) {
  /* ───────────── jogadores ───────────── */

  app.get("/admin/users", async (req) => {
    await app.authenticate(req, staff);
    const { q, role, status } = usersQuery.parse(req.query);
    const users = await prisma.user.findMany({
      where: {
        ...(role ? { role } : {}),
        ...(status ? { isActive: status === "active" } : {}),
        ...(q ? { OR: [{ email: { contains: q } }, { displayName: { contains: q } }, { cpf: { contains: q } }] } : {}),
      },
      select: {
        id: true, email: true, displayName: true, cpf: true, role: true, isActive: true, createdAt: true,
        wallet: { select: { id: true, balance: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    const totals = await walletTotals(users.flatMap((u) => (u.wallet ? [u.wallet.id] : [])));
    return users.map(({ wallet, ...u }) => ({
      ...u,
      balance: Number(wallet?.balance ?? 0),
      ...(totals.get(wallet?.id ?? "") ?? emptyTotals()),
    }));
  });

  app.get("/admin/users/:id", async (req) => {
    await app.authenticate(req, staff);
    const { id } = idParamSchema.parse(req.params);
    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true, email: true, displayName: true, cpf: true, role: true, isActive: true, createdAt: true,
        wallet: { select: { id: true, balance: true, currency: true } },
        kyc: { select: { level: true, verified: true } },
      },
    });
    if (!user) throw new AppError("Jogador não encontrado", 404, "NOT_FOUND");
    const walletId = user.wallet?.id;
    const [txs, betslips, pix, sessions, totals] = await Promise.all([
      walletId
        ? prisma.walletTransaction.findMany({
            where: { walletId },
            orderBy: { createdAt: "desc" },
            take: 100,
            select: { id: true, type: true, amount: true, balanceAfter: true, reference: true, meta: true, roundId: true, createdAt: true, game: { select: { name: true } } },
          })
        : [],
      prisma.betslip.findMany({
        where: { userId: id },
        orderBy: { createdAt: "desc" },
        take: 50,
        include: { selections: { include: { event: { select: { homeTeam: true, awayTeam: true, league: true } } } } },
      }),
      prisma.pixOrder.findMany({ where: { userId: id }, orderBy: { createdAt: "desc" }, take: 50 }),
      prisma.casinoSession.findMany({
        where: { userId: id },
        orderBy: { startedAt: "desc" },
        take: 30,
        // o token da sessão é credencial do provedor: não sai do servidor
        select: { id: true, mode: true, integration: true, stakeIn: true, stakeOut: true, rounds: true, startedAt: true, lastActivityAt: true, game: { select: { name: true } } },
      }),
      walletTotals(walletId ? [walletId] : []),
    ]);
    return {
      user: { ...user, balance: Number(user.wallet?.balance ?? 0) },
      totals: totals.get(walletId ?? "") ?? emptyTotals(),
      txs,
      betslips,
      pix,
      sessions,
    };
  });

  // Ajuste manual de saldo (crédito ou débito) com motivo; vai para o extrato e para a auditoria.
  app.post("/admin/users/:id/adjust", async (req) => {
    const jwt = await app.authenticate(req, finance);
    const { id } = idParamSchema.parse(req.params);
    const { amount, reason } = adjustSchema.parse(req.body);
    const wallet = await prisma.wallet.findUnique({ where: { userId: id } });
    if (!wallet) throw new AppError("Carteira inexistente", 404, "NOT_FOUND");
    const value = new Decimal(amount).toDecimalPlaces(2);
    const after = await prisma.$transaction(async (tx) => {
      if (value.lt(0)) {
        const ok = await tx.wallet.updateMany({
          where: { id: wallet.id, balance: { gte: value.negated() } },
          data: { balance: { increment: value } },
        });
        if (ok.count === 0) throw new AppError("Saldo insuficiente para esse débito", 400, "INSUFFICIENT_FUNDS");
      } else {
        await tx.wallet.update({ where: { id: wallet.id }, data: { balance: { increment: value } } });
      }
      const w = await tx.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
      await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          type: "ADJUSTMENT",
          amount: value,
          balanceAfter: w.balance,
          reference: `admin:${jwt.sub}`,
          meta: JSON.stringify({ reason }),
        },
      });
      await tx.adminAuditLog.create({
        data: { adminId: jwt.sub, action: "BALANCE_ADJUST", target: id, payload: JSON.stringify({ amount: Number(value), reason }) },
      });
      return w;
    });
    return { balance: Number(after.balance) };
  });

  /* ───────────── financeiro (PIX) ───────────── */

  app.get("/admin/pix", async (req) => {
    await app.authenticate(req, finance);
    const { status, kind, q } = pixQuery.parse(req.query);
    return prisma.pixOrder.findMany({
      where: {
        ...(status ? { status } : {}),
        ...(kind ? { kind } : {}),
        ...(q ? { user: { email: { contains: q } } } : {}),
      },
      include: { user: { select: { id: true, email: true, displayName: true } } },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
  });

  app.get("/admin/pix/summary", async (req) => {
    await app.authenticate(req, finance);
    const groups = await prisma.pixOrder.groupBy({
      by: ["kind", "status"],
      _sum: { amount: true },
      _count: { _all: true },
    });
    const pick = (kind: string, status: string) => {
      const g = groups.find((x) => x.kind === kind && x.status === status);
      return { count: g?._count._all ?? 0, amount: Number(g?._sum.amount ?? 0) };
    };
    return {
      pendingDeposits: pick("DEPOSIT", "PENDING"),
      pendingWithdrawals: pick("WITHDRAW", "PENDING"),
      paidDeposits: pick("DEPOSIT", "PAID"),
      paidWithdrawals: pick("WITHDRAW", "PAID"),
    };
  });

  app.post("/admin/pix/:id/reject", async (req) => {
    const jwt = await app.authenticate(req, finance);
    const { id } = idParamSchema.parse(req.params);
    const { reason } = rejectSchema.parse(req.body);
    // Recusa só se ainda estiver pendente (não "desfaz" uma ordem já paga).
    const done = await prisma.pixOrder.updateMany({ where: { id, status: "PENDING" }, data: { status: "FAILED", note: reason } });
    if (done.count !== 1) {
      const exists = await prisma.pixOrder.findUnique({ where: { id } });
      throw exists ? new AppError("Ordem já processada", 400) : new AppError("Ordem não encontrada", 404, "NOT_FOUND");
    }
    await prisma.adminAuditLog.create({ data: { adminId: jwt.sub, action: "PIX_REJECT", target: id, payload: JSON.stringify({ reason }) } });
    return { ok: true };
  });

  /* ───────────── bilhetes de esportes ───────────── */

  app.get("/admin/betslips", async (req) => {
    await app.authenticate(req, staff);
    const { status, q } = betsQuery.parse(req.query);
    return prisma.betslip.findMany({
      where: { ...(status ? { status } : {}), ...(q ? { user: { email: { contains: q } } } : {}) },
      include: {
        user: { select: { id: true, email: true } },
        selections: { include: { event: { select: { homeTeam: true, awayTeam: true, league: true, status: true, result: true } } } },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
  });

  /* ───────────── auditoria ───────────── */

  app.get("/admin/audit", async (req) => {
    await app.authenticate(req, [Role.ADMIN]);
    const { action, q } = auditQuery.parse(req.query);
    const [logs, actions] = await Promise.all([
      prisma.adminAuditLog.findMany({
        where: {
          ...(action ? { action } : {}),
          ...(q ? { OR: [{ target: { contains: q } }, { payload: { contains: q } }] } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: 300,
      }),
      prisma.adminAuditLog.groupBy({ by: ["action"], _count: { _all: true } }),
    ]);
    const admins = await prisma.user.findMany({
      where: { id: { in: [...new Set(logs.map((l) => l.adminId))] } },
      select: { id: true, email: true },
    });
    const byId = new Map(admins.map((a) => [a.id, a.email]));
    return {
      logs: logs.map((l) => ({ ...l, adminEmail: byId.get(l.adminId) ?? l.adminId })),
      actions: actions.map((a) => ({ action: a.action, count: a._count._all })).sort((a, b) => a.action.localeCompare(b.action)),
    };
  });
}
