import type { FastifyInstance } from "fastify";
import { Role } from "@prisma/client";
import { z } from "zod";
import { makePeriod, summaryReport, casinoReport, sportsReport } from "../services/reports.js";

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data no formato AAAA-MM-DD");
const periodQuery = z.object({ from: ymd.optional(), to: ymd.optional() });
const financeRoles: Role[] = [Role.ADMIN, Role.FINANCE];

/** Relatórios financeiros do painel (GGR, RTP, depósitos/saques, jogadores, passivos). */
export async function reportRoutes(app: FastifyInstance) {
  app.get("/admin/reports/summary", async (req) => {
    await app.authenticate(req, financeRoles);
    const { from, to } = periodQuery.parse(req.query);
    return summaryReport(makePeriod(from, to));
  });

  app.get("/admin/reports/casino", async (req) => {
    await app.authenticate(req, financeRoles);
    const { from, to } = periodQuery.parse(req.query);
    return casinoReport(makePeriod(from, to));
  });

  app.get("/admin/reports/sports", async (req) => {
    await app.authenticate(req, financeRoles);
    const { from, to } = periodQuery.parse(req.query);
    return sportsReport(makePeriod(from, to));
  });
}
