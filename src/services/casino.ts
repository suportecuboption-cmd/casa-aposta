import crypto from "node:crypto";
import type { Game } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

/**
 * Registro de cada abertura de jogo (quem abriu, qual jogo, quando). A carteira dos jogos da
 * PlayFivers é movida pelos webhooks dela (services/playfivers.ts), não por esta sessão.
 */
export async function createCasinoSession(userId: string, game: Game, mode: "real" | "demo") {
  return prisma.casinoSession.create({
    data: {
      userId,
      gameId: game.id,
      token: crypto.randomBytes(24).toString("hex"),
      integration: game.integration,
      mode,
    },
  });
}
