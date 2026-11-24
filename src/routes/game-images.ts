import type { FastifyInstance } from "fastify";
import { Role } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { imageStats, startImageJob } from "../services/game-images.js";

const admin: Role[] = [Role.ADMIN];

/** Capas dos jogos: quantas já estão no servidor e o botão de baixar (roda em segundo plano). */
export async function gameImagesRoutes(app: FastifyInstance) {
  app.get("/admin/games/images", async (req) => {
    await app.authenticate(req, admin);
    return imageStats();
  });

  app.post("/admin/games/images/download", async (req) => {
    const jwt = await app.authenticate(req, admin);
    const before = await imageStats();
    if (!before.job.running) {
      await prisma.adminAuditLog.create({
        data: { adminId: jwt.sub, action: "GAME_IMAGES_DOWNLOAD", target: "games", payload: JSON.stringify({ pending: before.remote }) },
      });
    }
    startImageJob((j) => app.log.info({ done: j.done, failed: j.failed, total: j.total, lastError: j.lastError }, "capas dos jogos baixadas"));
    return imageStats();
  });
}
