import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { gamesQuerySchema } from "../schemas/index.js";
import { catalogPayload } from "../services/catalog-cache.js";
import { getWalletSettings } from "../services/casino-wallets.js";
import { coversFirst } from "../services/game-images.js";
import { providerDisplayNames } from "../lib/provider-name.js";

// Só o que o site usa: com milhares de jogos, cada campo a menos pesa na resposta.
const GAME_SELECT = {
  id: true, name: true, category: true, imageUrl: true, hasDemo: true, isLive: true,
  featured: true, sortOrder: true, integration: true,
  provider: { select: { slug: true, name: true, logoUrl: true } },
} satisfies Prisma.GameSelect;
// "Em alta" primeiro (na ordem escolhida no admin), depois a ordem manual e o nome. Em seguida,
// coversFirst põe os jogos com capa antes dos sem capa, sem mexer no "Em alta" nem na ordem manual.
const GAME_ORDER: Prisma.GameOrderByWithRelationInput[] = [{ featured: "desc" }, { sortOrder: "asc" }, { name: "asc" }];

export async function catalogRoutes(app: FastifyInstance) {
  app.get("/games", async (req, reply) => {
    const q = gamesQuerySchema.parse(req.query);
    // Só jogos ativos de provedores das carteiras habilitadas na conta da PlayFivers (nada habilitado = vazio).
    const visible = async (): Promise<Prisma.GameWhereInput> => {
      const { enabled } = await getWalletSettings();
      return {
        isActive: true,
        ...(q.category ? { category: q.category } : {}),
        provider: { wallet: { in: enabled }, ...(q.provider ? { slug: q.provider } : {}) },
      };
    };
    const list = async () => {
      const games = coversFirst(await prisma.game.findMany({ where: await visible(), select: GAME_SELECT, orderBy: GAME_ORDER }));
      // nome do provedor limpo para o jogador ("OFICIAL - PG SOFT" → "PG Soft"); o admin vê o nome cru
      const names = providerDisplayNames(games.map((g) => g.provider.name));
      return games.map((g) => ({ ...g, provider: { ...g.provider, name: names.get(g.provider.name) ?? g.provider.name } }));
    };
    if (q.category || q.provider) return list();
    // Catálogo inteiro (o que o site carrega): sai do cache, já em gzip quando o navegador aceita.
    const c = await catalogPayload(list);
    reply.header("content-type", "application/json; charset=utf-8").header("vary", "accept-encoding");
    if (/\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))) return reply.header("content-encoding", "gzip").send(c.gz);
    return reply.send(c.json);
  });

  app.get("/sports", async () => {
    return prisma.sportEvent.findMany({
      where: { startsAt: { gte: new Date(Date.now() - 86_400_000) } },
      orderBy: { startsAt: "asc" },
      take: 100,
    });
  });
}