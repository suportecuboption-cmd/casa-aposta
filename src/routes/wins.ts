import type { FastifyInstance } from "fastify";
import { Role } from "@prisma/client";
import {
  getWinsFeedConfig,
  loadWins,
  publicWinsFeed,
  saveWinsFeedConfig,
  toAdminWin,
  winsFeedConfigSchema,
} from "../services/wins-feed.js";

const staff: Role[] = [Role.ADMIN, Role.FINANCE, Role.SUPPORT];

/** Vitrine pública "Grandes vitórias recentes" (home do site). */
export async function winsRoutes(app: FastifyInstance) {
  app.get("/wins/recent", async (_req, reply) => {
    reply.header("Cache-Control", "public, max-age=10");
    return publicWinsFeed();
  });
}

/** Ajustes da vitrine no admin: ver o que está no ar, testar filtros sem salvar e salvar. */
export async function winsAdminRoutes(app: FastifyInstance) {
  app.get("/admin/wins-feed", async (req) => {
    await app.authenticate(req, staff);
    const config = await getWinsFeedConfig();
    return { config, items: (await loadWins(config)).map(toAdminWin) };
  });

  app.post("/admin/wins-feed/preview", async (req) => {
    await app.authenticate(req, staff);
    const config = winsFeedConfigSchema.parse(req.body);
    return { config, items: (await loadWins(config)).map(toAdminWin) };
  });

  app.put("/admin/wins-feed", async (req) => {
    const jwt = await app.authenticate(req, [Role.ADMIN]);
    const config = winsFeedConfigSchema.parse(req.body);
    await saveWinsFeedConfig(config, jwt.sub);
    return { config, items: (await loadWins(config)).map(toAdminWin) };
  });
}
