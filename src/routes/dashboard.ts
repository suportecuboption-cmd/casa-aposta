import type { FastifyInstance } from "fastify";
import { Role } from "@prisma/client";
import { dashQuerySchema, dashboardParamsSchema } from "../schemas/index.js";
import {
  dashPeriod,
  dashboardSummary,
  dashboardCasino,
  dashboardSports,
  dashboardWallets,
  getDashboardParams,
  saveDashboardParams,
} from "../services/dashboard.js";

const financeRoles: Role[] = [Role.ADMIN, Role.FINANCE];

/** Dashboard no modelo do Axio Backoffice (abas, período com comparação e parâmetros). */
export async function dashboardRoutes(app: FastifyInstance) {
  // Visão Geral, Pagamentos, Carteira & Moedas e Cassino & Jogadores (atual + período anterior).
  app.get("/admin/dash/summary", async (req) => {
    await app.authenticate(req, financeRoles);
    const q = dashQuerySchema.parse(req.query);
    return dashboardSummary(dashPeriod(q.from, q.to), q);
  });

  // Provedores e Jogos.
  app.get("/admin/dash/casino", async (req) => {
    await app.authenticate(req, financeRoles);
    const q = dashQuerySchema.parse(req.query);
    return dashboardCasino(dashPeriod(q.from, q.to), q);
  });

  // Esportes (bilhetes).
  app.get("/admin/dash/sports", async (req) => {
    await app.authenticate(req, financeRoles);
    const q = dashQuerySchema.parse(req.query);
    return dashboardSports(dashPeriod(q.from, q.to), q);
  });

  // Carteiras pré-pagas do agregador (PlayFivers) com GGR % e saldo mínimo.
  app.get("/admin/dash/wallets", async (req) => {
    await app.authenticate(req, financeRoles);
    const q = dashQuerySchema.parse(req.query);
    return dashboardWallets(dashPeriod(q.from, q.to));
  });

  app.get("/admin/dash/params", async (req) => {
    await app.authenticate(req, financeRoles);
    return getDashboardParams();
  });

  app.put("/admin/dash/params", async (req) => {
    const jwt = await app.authenticate(req, [Role.ADMIN]);
    const params = dashboardParamsSchema.parse(req.body);
    return saveDashboardParams(params, jwt.sub);
  });
}
