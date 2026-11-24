import type { FastifyInstance, FastifyRequest } from "fastify";
import { Role } from "@prisma/client";
import {
  vipConfigSchema, vipClaimSchema, collectionsSettingsSchema, collectionInputSchema, collectionIdSchema, gameSearchSchema, autofillSchema,
} from "../schemas/index.js";
import { playerVip, claimVipReward, saveVipConfig, vipAdminView } from "../services/vip.js";
import {
  playerCollections, openPack, claimCollection, collectionsAdminView, saveCollectionsSettings, saveCollection, deleteCollection,
  searchGamesForCollections, autofillGames,
} from "../services/collections.js";

/** Fidelidade do jogador: Nível VIP e Coleções (sem login dá para ver; resgatar e abrir pede login). */
export async function loyaltyRoutes(app: FastifyInstance) {
  const optionalUser = async (req: FastifyRequest) => {
    if (!req.headers.authorization) return null;
    try {
      return (await app.authenticate(req)).sub;
    } catch {
      return null;
    }
  };

  app.get("/vip", async (req) => playerVip(await optionalUser(req)));
  app.post("/vip/claim", async (req) => {
    const jwt = await app.authenticate(req);
    const { level } = vipClaimSchema.parse(req.body);
    return claimVipReward(jwt.sub, level);
  });

  app.get("/collections", async (req) => playerCollections(await optionalUser(req)));
  app.post("/collections/packs/open", async (req) => {
    const jwt = await app.authenticate(req);
    return openPack(jwt.sub);
  });
  app.post("/collections/:id/claim", async (req) => {
    const jwt = await app.authenticate(req);
    const { id } = collectionIdSchema.parse(req.params);
    return claimCollection(jwt.sub, id);
  });
}

const admin: Role[] = [Role.ADMIN];

/** Admin → Fidelidade (só administrador). */
export async function loyaltyAdminRoutes(app: FastifyInstance) {
  app.get("/admin/vip", async (req) => {
    await app.authenticate(req, admin);
    return vipAdminView();
  });
  app.put("/admin/vip", async (req) => {
    const jwt = await app.authenticate(req, admin);
    await saveVipConfig(vipConfigSchema.parse(req.body), jwt.sub);
    return vipAdminView();
  });

  app.get("/admin/collections", async (req) => {
    await app.authenticate(req, admin);
    return collectionsAdminView();
  });
  app.put("/admin/collections/settings", async (req) => {
    const jwt = await app.authenticate(req, admin);
    await saveCollectionsSettings(collectionsSettingsSchema.parse(req.body), jwt.sub);
    return collectionsAdminView();
  });
  app.post("/admin/collections", async (req) => {
    const jwt = await app.authenticate(req, admin);
    await saveCollection(null, collectionInputSchema.parse(req.body), jwt.sub);
    return collectionsAdminView();
  });
  app.put("/admin/collections/:id", async (req) => {
    const jwt = await app.authenticate(req, admin);
    const { id } = collectionIdSchema.parse(req.params);
    await saveCollection(id, collectionInputSchema.parse(req.body), jwt.sub);
    return collectionsAdminView();
  });
  app.delete("/admin/collections/:id", async (req) => {
    const jwt = await app.authenticate(req, admin);
    const { id } = collectionIdSchema.parse(req.params);
    await deleteCollection(id, jwt.sub);
    return collectionsAdminView();
  });
  app.get("/admin/collections/games", async (req) => {
    await app.authenticate(req, admin);
    const { q } = gameSearchSchema.parse(req.query);
    return searchGamesForCollections(q);
  });
  app.post("/admin/collections/autofill", async (req) => {
    await app.authenticate(req, admin);
    const { providerSlug, count } = autofillSchema.parse(req.body);
    return autofillGames(providerSlug, count);
  });
}
