import type { FastifyInstance } from "fastify";
import { idParamSchema, rgLimitSchema, selfExclusionSchema } from "../schemas/index.js";
import { playerProtection, playerSetLimit, playerRemoveLimit, playerSelfExclude } from "../services/protection.js";

/** Autosserviço do jogador: jogo responsável (limites e autoexclusão). */
export async function meRoutes(app: FastifyInstance) {
  app.get("/me/protection", async (req) => {
    const jwt = await app.authenticate(req);
    return playerProtection(jwt.sub);
  });
  app.post("/me/limits", async (req) => {
    const jwt = await app.authenticate(req);
    return playerSetLimit(jwt.sub, rgLimitSchema.parse(req.body));
  });
  app.delete("/me/limits/:id", async (req) => {
    const jwt = await app.authenticate(req);
    return playerRemoveLimit(jwt.sub, idParamSchema.parse(req.params).id);
  });
  app.post("/me/self-exclusion", async (req) => {
    const jwt = await app.authenticate(req);
    return playerSelfExclude(jwt.sub, selfExclusionSchema.parse(req.body).days);
  });
}
