import type { FastifyInstance } from "fastify";
import { Role } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";
import { idParamSchema } from "../schemas/index.js";
import {
  opsPixQuery, opsUsersQuery, testAccountSchema, rangeQuery, userPixQuery, ledgerQuery,
  restrictionSchema, restrictionEditSchema, revokeSchema, rgLimitSchema, withdrawLimitsSchema, testFlagSchema,
  rankingPlayersQuery, rankingGamesQuery, riskQuery, riskResultsQuery, riskAlertsSchema,
  restrictionsQuery, adjustmentsQuery, invoiceMonthParam, invoicePaymentSchema, invoiceParamsSchema,
} from "../schemas/ops.js";
import { pixList, pixDetail } from "../services/ops-pix.js";
import {
  usersList, createTestAccount, setTestFlag, userDetail, userBets, userTopGames, userLedger, userTimeline, userSecurity,
  addRestriction, editRestriction, revokeRestriction, addRgLimit, removeRgLimit, setUserWithdrawLimits,
} from "../services/ops-users.js";
import {
  rankingPlayers, rankingGames, riskOverview, riskResults, riskScores, getRiskAlerts, saveRiskAlerts, restrictionsList, adjustmentsList,
} from "../services/ops-insights.js";
import { getHouseWithdrawLimits, saveHouseWithdrawLimits } from "../services/protection.js";
import { invoiceMonths, invoiceDetail, getInvoiceParams, saveInvoiceParams } from "../services/invoices.js";

const staff: Role[] = [Role.ADMIN, Role.FINANCE, Role.SUPPORT];
const finance: Role[] = [Role.ADMIN, Role.FINANCE];
const admin: Role[] = [Role.ADMIN];
const DAY = 86_400_000;

/** Operação (modelo Axio): depósitos, saques, usuários e ficha, risco, bloqueios, ajustes e faturas. */
export async function opsRoutes(app: FastifyInstance) {
  /* ── Depósitos e Saques ── */
  app.get("/admin/ops/pix", async (req) => {
    await app.authenticate(req, staff);
    return pixList(opsPixQuery.parse(req.query));
  });
  app.get("/admin/ops/pix/:id", async (req) => {
    await app.authenticate(req, staff);
    return pixDetail(idParamSchema.parse(req.params).id);
  });

  /* ── Usuários ── */
  app.get("/admin/ops/users", async (req) => {
    await app.authenticate(req, staff);
    return usersList(opsUsersQuery.parse(req.query));
  });
  app.post("/admin/ops/users/test", async (req) => {
    const jwt = await app.authenticate(req, admin);
    return createTestAccount(testAccountSchema.parse(req.body), jwt.sub);
  });
  app.get("/admin/ops/users/:id", async (req) => {
    await app.authenticate(req, staff);
    return userDetail(idParamSchema.parse(req.params).id);
  });
  app.patch("/admin/ops/users/:id/test", async (req) => {
    const jwt = await app.authenticate(req, admin);
    return setTestFlag(idParamSchema.parse(req.params).id, testFlagSchema.parse(req.body).isTest, jwt.sub);
  });
  app.get("/admin/ops/users/:id/bets", async (req) => {
    await app.authenticate(req, staff);
    return userBets(idParamSchema.parse(req.params).id, rangeQuery.parse(req.query));
  });
  app.get("/admin/ops/users/:id/top-games", async (req) => {
    await app.authenticate(req, staff);
    return userTopGames(idParamSchema.parse(req.params).id, rangeQuery.parse(req.query));
  });
  app.get("/admin/ops/users/:id/pix", async (req) => {
    await app.authenticate(req, staff);
    const { id } = idParamSchema.parse(req.params);
    const q = userPixQuery.parse(req.query);
    return pixList({ ...q, userId: id, tab: "all", sort: "date", dir: "desc" });
  });
  app.get("/admin/ops/users/:id/ledger", async (req) => {
    await app.authenticate(req, staff);
    return userLedger(idParamSchema.parse(req.params).id, ledgerQuery.parse(req.query));
  });
  app.get("/admin/ops/users/:id/timeline", async (req) => {
    await app.authenticate(req, staff);
    return userTimeline(idParamSchema.parse(req.params).id);
  });
  app.get("/admin/ops/users/:id/security", async (req) => {
    await app.authenticate(req, staff);
    return userSecurity(idParamSchema.parse(req.params).id);
  });

  /* ── Proteção do jogador ── */
  app.post("/admin/ops/users/:id/restrictions", async (req) => {
    const jwt = await app.authenticate(req, staff);
    return addRestriction(idParamSchema.parse(req.params).id, restrictionSchema.parse(req.body), jwt.sub);
  });
  app.patch("/admin/ops/restrictions/:id", async (req) => {
    const jwt = await app.authenticate(req, staff);
    const { days } = restrictionEditSchema.parse(req.body);
    return editRestriction(idParamSchema.parse(req.params).id, days == null ? null : new Date(Date.now() + days * DAY), jwt.sub);
  });
  // Retirar restrição antes do prazo é decisão de administrador (protege o jogador).
  app.post("/admin/ops/restrictions/:id/revoke", async (req) => {
    const jwt = await app.authenticate(req, admin);
    return revokeRestriction(idParamSchema.parse(req.params).id, revokeSchema.parse(req.body).note, jwt.sub);
  });
  app.post("/admin/ops/users/:id/limits", async (req) => {
    const jwt = await app.authenticate(req, staff);
    return addRgLimit(idParamSchema.parse(req.params).id, rgLimitSchema.parse(req.body), jwt.sub);
  });
  app.delete("/admin/ops/limits/:id", async (req) => {
    const jwt = await app.authenticate(req, staff);
    return removeRgLimit(idParamSchema.parse(req.params).id, jwt.sub);
  });
  app.put("/admin/ops/users/:id/withdraw-limits", async (req) => {
    const jwt = await app.authenticate(req, finance);
    return setUserWithdrawLimits(idParamSchema.parse(req.params).id, withdrawLimitsSchema.parse(req.body), jwt.sub);
  });
  app.get("/admin/ops/withdraw-limits/house", async (req) => {
    await app.authenticate(req, staff);
    return getHouseWithdrawLimits();
  });
  app.put("/admin/ops/withdraw-limits/house", async (req) => {
    const jwt = await app.authenticate(req, admin);
    return saveHouseWithdrawLimits(withdrawLimitsSchema.parse(req.body), jwt.sub);
  });

  /* ── Ranking Operacional ── */
  app.get("/admin/ops/ranking/players", async (req) => {
    await app.authenticate(req, staff);
    return rankingPlayers(rankingPlayersQuery.parse(req.query));
  });
  app.get("/admin/ops/ranking/games", async (req) => {
    await app.authenticate(req, staff);
    return rankingGames(rankingGamesQuery.parse(req.query));
  });

  /* ── Gestão de Risco ── */
  app.get("/admin/ops/risk", async (req) => {
    await app.authenticate(req, staff);
    return riskOverview(riskQuery.parse(req.query));
  });
  app.get("/admin/ops/risk/results", async (req) => {
    await app.authenticate(req, staff);
    return riskResults(riskResultsQuery.parse(req.query));
  });
  app.get("/admin/ops/risk/scores", async (req) => {
    await app.authenticate(req, staff);
    return riskScores(riskQuery.parse(req.query));
  });
  app.get("/admin/ops/risk/alerts", async (req) => {
    await app.authenticate(req, staff);
    return getRiskAlerts();
  });
  app.put("/admin/ops/risk/alerts", async (req) => {
    const jwt = await app.authenticate(req, admin);
    return saveRiskAlerts(riskAlertsSchema.parse(req.body), jwt.sub);
  });

  /* ── Bloqueios e Autoexclusões / Ajustes de saldo ── */
  app.get("/admin/ops/restrictions", async (req) => {
    await app.authenticate(req, staff);
    return restrictionsList(restrictionsQuery.parse(req.query));
  });
  app.get("/admin/ops/adjustments", async (req) => {
    await app.authenticate(req, finance);
    return adjustmentsList(adjustmentsQuery.parse(req.query));
  });

  /* ── Faturas ── */
  app.get("/admin/ops/invoices", async (req) => {
    await app.authenticate(req, finance);
    return invoiceMonths();
  });
  app.get("/admin/ops/invoices/params", async (req) => {
    await app.authenticate(req, finance);
    return getInvoiceParams();
  });
  app.put("/admin/ops/invoices/params", async (req) => {
    const jwt = await app.authenticate(req, admin);
    return saveInvoiceParams(invoiceParamsSchema.parse(req.body), jwt.sub);
  });
  app.get("/admin/ops/invoices/:month", async (req) => {
    await app.authenticate(req, finance);
    return invoiceDetail(invoiceMonthParam.parse(req.params).month);
  });
  app.post("/admin/ops/invoices/:month/payments", async (req) => {
    const jwt = await app.authenticate(req, finance);
    const { month } = invoiceMonthParam.parse(req.params);
    const body = invoicePaymentSchema.parse(req.body);
    const pay = await prisma.invoicePayment.create({
      data: { month, amount: new Decimal(body.amount).toDecimalPlaces(2), paidAt: new Date(`${body.paidAt}T12:00:00-03:00`), note: body.note ?? null, createdBy: jwt.sub },
    });
    await prisma.adminAuditLog.create({ data: { adminId: jwt.sub, action: "INVOICE_PAYMENT_ADD", target: month, payload: JSON.stringify({ paymentId: pay.id, ...body }) } });
    return { id: pay.id };
  });
  app.delete("/admin/ops/invoices/payments/:id", async (req) => {
    const jwt = await app.authenticate(req, admin);
    const { id } = idParamSchema.parse(req.params);
    const pay = await prisma.invoicePayment.findUnique({ where: { id } });
    if (!pay) throw new AppError("Pagamento não encontrado", 404, "NOT_FOUND");
    await prisma.$transaction([
      prisma.invoicePayment.delete({ where: { id } }),
      prisma.adminAuditLog.create({ data: { adminId: jwt.sub, action: "INVOICE_PAYMENT_DELETE", target: pay.month, payload: JSON.stringify({ paymentId: id, amount: Number(pay.amount) }) } }),
    ]);
    return { ok: true };
  });
}
