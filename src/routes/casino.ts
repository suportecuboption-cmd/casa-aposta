import type { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";
import { launchSchema } from "../schemas/index.js";
import { getAdapter } from "../casino/registry.js";
import { guardPlay } from "../services/protection.js";
import { createCasinoSession } from "../services/casino.js";
import { getWalletSettings } from "../services/casino-wallets.js";
import { playableBalance } from "../services/incentives.js";

/* ───────────── abrir jogo (site) ───────────── */

export async function casinoRoutes(app: FastifyInstance) {
  // Devolve a URL do iframe do agregador (PlayFivers). Valendo dinheiro exige login.
  app.post("/casino/launch", async (req) => {
    const { gameId, mode } = launchSchema.parse(req.body);
    const game = await prisma.game.findUnique({ where: { id: gameId }, include: { provider: true } });
    if (!game || !game.isActive) throw new AppError("Jogo não encontrado", 404, "NOT_FOUND");
    // Só abre jogo de carteira habilitada na conta (o site nem lista os outros; isto barra id enviado direto).
    const { enabled } = await getWalletSettings();
    if (!game.provider.wallet || !enabled.includes(game.provider.wallet)) {
      throw new AppError("Jogo indisponível no momento", 409, "GAME_UNAVAILABLE");
    }
    const adapter = getAdapter(game.integration);
    if (!adapter || !adapter.configured() || !game.externalId) {
      throw new AppError("Jogo indisponível no momento", 409, "GAME_UNAVAILABLE");
    }
    // Dados de launch gravados na sincronização: o código cru do jogo e o nome do provedor como
    // o agregador conhece (o externalId é "<provedor>:<código>" e o nome do provedor pode ser trocado no admin).
    let meta: { original?: boolean; code?: string; provider?: string } = {};
    try { meta = game.meta ? JSON.parse(game.meta) : {}; } catch { meta = {}; }
    const externalId = meta.code || game.externalId;
    // Qualquer falha do agregador ao abrir (ex.: carteira do agente sem saldo) vira uma mensagem
    // genérica pro jogador — "Provedor indisponível no momento" — e o motivo real fica no log do
    // servidor pro operador (não expomos "saldo insuficiente" etc. na tela do usuário).
    const openGame = async (launch: () => Promise<string>) => {
      try {
        return { mode, url: await launch() };
      } catch (e) {
        req.log.warn(
          { reason: e instanceof Error ? e.message : String(e), gameId: game.id, provider: game.provider.name, wallet: game.provider.wallet },
          "launch do agregador falhou",
        );
        throw new AppError("Provedor indisponível no momento", 409, "PROVIDER_UNAVAILABLE");
      }
    };
    if (mode === "demo") {
      if (!game.hasDemo) throw new AppError("Este jogo não tem modo demo", 400, "NO_DEMO");
      return openGame(() => adapter.launchUrl({ externalId, mode: "demo" }));
    }
    const jwt = await app.authenticate(req);
    const user = await prisma.user.findUnique({ where: { id: jwt.sub }, include: { wallet: true } });
    if (!user || !user.isActive) throw new AppError("Conta bloqueada", 403, "PLAYER_BLOCKED");
    await guardPlay(user.id, 0); // em autoexclusão/suspensão ou com limite estourado, nem abre o jogo
    const session = await createCasinoSession(user.id, game, "real");
    return openGame(async () =>
      adapter.launchUrl({
        externalId,
        mode: "real",
        token: session.token ?? undefined,
        userCode: user.id,
        userBalance: await playableBalance(user.id, game.id), // real + bônus quando o jogo é da campanha ativa
        providerName: meta.provider || game.provider.name,
        gameOriginal: Boolean(meta.original),
        lang: "pt",
      }),
    );
  });
}
