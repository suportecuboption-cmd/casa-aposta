import type { FastifyInstance, FastifyRequest } from "fastify";
import { Role } from "@prisma/client";
import {
  campaignInputSchema, incentiveIdSchema, incentiveGrantSchema, incentiveCancelSchema, incentiveGrantsQuery, incentiveAutofillSchema, gameSearchSchema,
} from "../schemas/index.js";
import {
  playerIncentives, claimIncentive, cancelActiveIncentive,
  incentivesAdminView, getCampaign, saveCampaign, deleteCampaign, grantManual, cancelByAdmin, grantsList, grantLedger,
} from "../services/incentives.js";
import { searchGamesForCollections, autofillGames } from "../services/collections.js";

/** Incentivos do jogador: ver as campanhas não pede login; ativar e cancelar, sim. */
export async function incentiveRoutes(app: FastifyInstance) {
  const optionalUser = async (req: FastifyRequest) => {
    if (!req.headers.authorization) return null;
    try {
      return (await app.authenticate(req)).sub;
    } catch {
      return null;
    }
  };

  app.get("/incentives", async (req) => playerIncentives(await optionalUser(req)));
  app.post("/incentives/:id/claim", async (req) => {
    const jwt = await app.authenticate(req);
    const { id } = incentiveIdSchema.parse(req.params);
    return claimIncentive(jwt.sub, id);
  });
  app.post("/incentives/active/cancel", async (req) => {
    const jwt = await app.authenticate(req);
    return cancelActiveIncentive(jwt.sub);
  });
}

const staff: Role[] = [Role.ADMIN, Role.FINANCE, Role.SUPPORT];
const money: Role[] = [Role.ADMIN, Role.FINANCE];
const admin: Role[] = [Role.ADMIN];

/** Admin → Incentivos: campanhas (só administrador), concessão e cancelamento (administrador e financeiro). */
export async function incentiveAdminRoutes(app: FastifyInstance) {
  app.get("/admin/incentives", async (req) => {
    await app.authenticate(req, staff);
    return incentivesAdminView();
  });
  app.get("/admin/incentives/campaigns/:id", async (req) => {
    await app.authenticate(req, staff);
    return getCampaign(incentiveIdSchema.parse(req.params).id);
  });
  app.post("/admin/incentives/campaigns", async (req) => {
    const jwt = await app.authenticate(req, admin);
    const c = await saveCampaign(null, campaignInputSchema.parse(req.body), jwt.sub);
    return { ok: true, id: c.id };
  });
  app.put("/admin/incentives/campaigns/:id", async (req) => {
    const jwt = await app.authenticate(req, admin);
    const { id } = incentiveIdSchema.parse(req.params);
    await saveCampaign(id, campaignInputSchema.parse(req.body), jwt.sub);
    return { ok: true, id };
  });
  app.delete("/admin/incentives/campaigns/:id", async (req) => {
    const jwt = await app.authenticate(req, admin);
    return deleteCampaign(incentiveIdSchema.parse(req.params).id, jwt.sub);
  });

  app.get("/admin/incentives/grants", async (req) => {
    await app.authenticate(req, staff);
    return grantsList(incentiveGrantsQuery.parse(req.query));
  });
  app.get("/admin/incentives/grants/:id", async (req) => {
    await app.authenticate(req, staff);
    return grantLedger(incentiveIdSchema.parse(req.params).id);
  });
  app.post("/admin/incentives/grants", async (req) => {
    const jwt = await app.authenticate(req, money);
    return grantManual(jwt.sub, incentiveGrantSchema.parse(req.body));
  });
  app.post("/admin/incentives/grants/:id/cancel", async (req) => {
    const jwt = await app.authenticate(req, money);
    const { id } = incentiveIdSchema.parse(req.params);
    const { note } = incentiveCancelSchema.parse(req.body ?? {});
    return cancelByAdmin(jwt.sub, id, note);
  });

  // escolha dos jogos da campanha: busca por nome e "todos os jogos de um provedor"
  app.get("/admin/incentives/games", async (req) => {
    await app.authenticate(req, admin);
    return searchGamesForCollections(gameSearchSchema.parse(req.query).q);
  });
  app.post("/admin/incentives/autofill", async (req) => {
    await app.authenticate(req, admin);
    return autofillGames(incentiveAutofillSchema.parse(req.body).providerSlug, 3000);
  });
}
