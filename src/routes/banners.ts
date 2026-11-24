import type { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma.js";
import { bannerQuerySchema } from "../schemas/index.js";

/** Rotas públicas de banner, consumidas pela home do player-ui. */
export async function bannerRoutes(app: FastifyInstance) {
  app.get("/banners", async (req) => {
    const { placement } = bannerQuerySchema.parse(req.query);
    return prisma.banner.findMany({
      where: { isActive: true, ...(placement ? { placement } : {}) },
      orderBy: [{ placement: "asc" }, { sortOrder: "asc" }, { createdAt: "asc" }],
    });
  });
}
