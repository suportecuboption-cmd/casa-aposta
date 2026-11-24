import type { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";
import { placeBetslipSchema, idParamSchema } from "../schemas/index.js";
import { placeBetslip } from "../services/betslip.js";
import { guardPlay } from "../services/protection.js";

export async function betslipRoutes(app: FastifyInstance) {
  // Monta e registra um bilhete (simples = 1 seleção, acumulada = 2+).
  app.post("/betslips", async (req) => {
    const jwt = await app.authenticate(req);
    const input = placeBetslipSchema.parse(req.body);
    await guardPlay(jwt.sub, input.stake); // autoexclusão/suspensão e limites de jogo responsável
    return placeBetslip(jwt.sub, input);
  });

  app.get("/betslips/mine", async (req) => {
    const jwt = await app.authenticate(req);
    return prisma.betslip.findMany({
      where: { userId: jwt.sub },
      include: { selections: { include: { event: true } } },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  });

  app.get("/betslips/:id", async (req) => {
    const jwt = await app.authenticate(req);
    const { id } = idParamSchema.parse(req.params);
    const slip = await prisma.betslip.findUnique({
      where: { id },
      include: { selections: { include: { event: true } } },
    });
    if (!slip || slip.userId !== jwt.sub) {
      throw new AppError("Bilhete não encontrado", 404, "NOT_FOUND");
    }
    return slip;
  });
}
