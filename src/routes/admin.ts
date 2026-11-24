import type { FastifyInstance } from "fastify";
import { Decimal } from "@prisma/client/runtime/library";
import { Prisma, Role } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";
import {
  patchUserSchema,
  createGameSchema,
  updateGameSchema,
  gameOrderSchema,
  gameFeaturedSchema,
  gameBulkActiveSchema,
  casinoWalletsSchema,
  idParamSchema,
  settleEventSchema,
  createBannerSchema,
  updateBannerSchema,
  bannerUploadSchema,
  imageUploadSchema,
  patchProviderSchema,
  createEventSchema,
  updateEventSchema,
  pfAgentUpdateSchema,
  pfFreeBonusGrantSchema,
} from "../schemas/index.js";
import { settleEvent, cancelEvent } from "../services/betslip.js";
import { z } from "zod";
import { listAdapters, getAdapter } from "../casino/registry.js";
import { playfiversAdapter } from "../casino/adapters/playfivers.js";
import { syncCatalog } from "../services/catalog-sync.js";
import { invalidateCatalog } from "../services/catalog-cache.js";
import { walletsOverview, saveManualWallets, detectWallets } from "../services/casino-wallets.js";
import { saveDataUrl } from "../lib/uploads.js";
import { settleDeposit, approveWithdraw } from "../services/pix-settle.js";
import { activeGateway, webhookUrlFor, payerOf } from "../payments/registry.js";
import { startImageJob } from "../services/game-images.js";

const adminRoles: Role[] = [Role.ADMIN, Role.FINANCE, Role.SUPPORT];

// Violação de campo único (ex.: slug repetido).
const isUniqueViolation = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

export async function adminRoutes(app: FastifyInstance) {
  app.get("/admin/dashboard", async (req) => {
    await app.authenticate(req, adminRoles);
    const [users, openBetslips, pendingPix, ggr] = await Promise.all([
      prisma.user.count(),
      prisma.betslip.count({ where: { status: "OPEN" } }),
      prisma.pixOrder.count({ where: { status: "PENDING" } }),
      prisma.walletTransaction.aggregate({ _sum: { amount: true } }),
    ]);
    return {
      users,
      openBetslips,
      pendingPix,
      volume: ggr._sum.amount?.toString() ?? "0",
    };
  });

  app.patch("/admin/users/:id", async (req) => {
    const jwt = await app.authenticate(req, [Role.ADMIN]);
    const { id } = idParamSchema.parse(req.params);
    const body = patchUserSchema.parse(req.body);
    const user = await prisma.user.update({ where: { id }, data: body });
    await prisma.adminAuditLog.create({
      data: {
        adminId: jwt.sub,
        action: "USER_UPDATE",
        target: id,
        payload: JSON.stringify(body),
      },
    });
    return user;
  });

  // Aprovação manual (Operação → Depósitos/Saques). Depósito: credita — modo manual, ou quando o aviso
  // do gateway não chegou. Saque: no modo manual debita e marca pago; com gateway ativo, debita e envia
  // o payout (a ordem fica "Processando" até o aviso do gateway; se ele recusar na hora, o saldo volta).
  app.post("/admin/pix/:id/approve", async (req) => {
    const jwt = await app.authenticate(req, [Role.ADMIN, Role.FINANCE]);
    const { id } = idParamSchema.parse(req.params);
    const order = await prisma.pixOrder.findUnique({
      where: { id },
      include: { user: { select: { email: true, displayName: true, cpf: true } } },
    });
    if (!order) throw new AppError("Ordem não encontrada", 404);
    if (order.status !== "PENDING") throw new AppError("Ordem já processada", 400);
    if (order.kind === "DEPOSIT") {
      const ok = await settleDeposit(id, { txid: order.txid ? undefined : `MOCK-${Date.now()}-${id.slice(-8)}`, adminId: jwt.sub });
      if (!ok) throw new AppError("Ordem já processada", 400);
      return { ok: true, status: "PAID" };
    }
    const gw = activeGateway();
    const r = await approveWithdraw(id, jwt.sub, gw, {
      postbackUrl: gw ? webhookUrlFor(gw.key) || undefined : undefined,
      payeeName: payerOf(order.user).name,
    });
    return { ok: true, status: r.status };
  });

  /* ----------------------------- Jogos ----------------------------- */

  // Todos os jogos, inclusive inativos (o /games público só mostra os ativos).
  app.get("/admin/games", async (req) => {
    await app.authenticate(req, adminRoles);
    return prisma.game.findMany({ include: { provider: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
  });

  // Reordenar a vitrine: grava sortOrder = posição na lista enviada.
  app.put("/admin/games/order", async (req) => {
    const jwt = await app.authenticate(req, [Role.ADMIN]);
    const { ids } = gameOrderSchema.parse(req.body);
    await prisma.$transaction(ids.map((id, i) => prisma.game.update({ where: { id }, data: { sortOrder: i } })));
    await prisma.adminAuditLog.create({ data: { adminId: jwt.sub, action: "GAME_REORDER", target: "games", payload: JSON.stringify({ count: ids.length }) } });
    invalidateCatalog();
    return { ok: true };
  });

  // "Em alta": entra no fim da fileira; ao sair, volta para a ordem padrão (por nome).
  app.post("/admin/games/:id/featured", async (req) => {
    const jwt = await app.authenticate(req, [Role.ADMIN]);
    const { id } = idParamSchema.parse(req.params);
    const { featured } = gameFeaturedSchema.parse(req.body);
    const game = await prisma.game.findUnique({ where: { id } });
    if (!game) throw new AppError("Jogo não encontrado", 404, "NOT_FOUND");
    let sortOrder = 0;
    if (featured) {
      const last = await prisma.game.aggregate({ where: { featured: true }, _max: { sortOrder: true } });
      sortOrder = game.featured ? game.sortOrder : (last._max.sortOrder ?? -1) + 1;
    }
    const updated = await prisma.game.update({ where: { id }, data: { featured, sortOrder }, include: { provider: true } });
    await prisma.adminAuditLog.create({
      data: { adminId: jwt.sub, action: featured ? "GAME_FEATURE" : "GAME_UNFEATURE", target: id, payload: game.name },
    });
    invalidateCatalog();
    return updated;
  });

  // Liga/desliga todos os jogos de um provedor de uma vez (ex.: ficar só com a versão "OFICIAL").
  app.post("/admin/games/bulk-active", async (req) => {
    const jwt = await app.authenticate(req, [Role.ADMIN]);
    const { providerSlug, isActive } = gameBulkActiveSchema.parse(req.body);
    const provider = await prisma.gameProvider.findUnique({ where: { slug: providerSlug } });
    if (!provider) throw new AppError("Provedor não encontrado", 404, "NOT_FOUND");
    const r = await prisma.game.updateMany({ where: { providerId: provider.id }, data: { isActive } });
    await prisma.adminAuditLog.create({
      data: { adminId: jwt.sub, action: "GAME_BULK_ACTIVE", target: provider.id, payload: JSON.stringify({ providerSlug, isActive, count: r.count }) },
    });
    invalidateCatalog();
    return { ok: true, count: r.count };
  });

  // Imagem do card (data URL → /uploads); o admin depois salva a URL no jogo.
  app.post(
    "/admin/games/upload",
    { bodyLimit: 9 * 1024 * 1024 },
    async (req) => {
      const jwt = await app.authenticate(req, [Role.ADMIN]);
      const { dataUrl } = imageUploadSchema.parse(req.body);
      const saved = saveDataUrl(dataUrl, "game");
      await prisma.adminAuditLog.create({
        data: { adminId: jwt.sub, action: "GAME_IMAGE_UPLOAD", target: saved.url },
      });
      return saved;
    },
  );

  app.post("/admin/games", async (req) => {
    const jwt = await app.authenticate(req, [Role.ADMIN]);
    const { providerSlug, imageUrl, ...body } = createGameSchema.parse(req.body);
    const provider = await prisma.gameProvider.findUnique({ where: { slug: providerSlug } });
    if (!provider) throw new AppError("Provedor não encontrado", 404, "NOT_FOUND");
    try {
      const game = await prisma.game.create({
        data: { ...body, providerId: provider.id, imageUrl: imageUrl || null },
        include: { provider: true },
      });
      await prisma.adminAuditLog.create({
        data: {
          adminId: jwt.sub,
          action: "GAME_CREATE",
          target: game.id,
          payload: JSON.stringify({ providerSlug, imageUrl, ...body }),
        },
      });
      invalidateCatalog();
      return game;
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError("Já existe um jogo com esse slug", 409, "CONFLICT");
      throw e;
    }
  });

  app.patch("/admin/games/:id", async (req) => {
    const jwt = await app.authenticate(req, [Role.ADMIN]);
    const { id } = idParamSchema.parse(req.params);
    const body = updateGameSchema.parse(req.body);
    const { providerSlug, imageUrl, ...rest } = body;
    const existing = await prisma.game.findUnique({ where: { id } });
    if (!existing) throw new AppError("Jogo não encontrado", 404, "NOT_FOUND");
    let providerId: string | undefined;
    if (providerSlug !== undefined) {
      const provider = await prisma.gameProvider.findUnique({ where: { slug: providerSlug } });
      if (!provider) throw new AppError("Provedor não encontrado", 404, "NOT_FOUND");
      providerId = provider.id;
    }
    try {
      const game = await prisma.game.update({
        where: { id },
        data: {
          ...rest,
          ...(providerId ? { providerId } : {}),
          ...(imageUrl !== undefined ? { imageUrl: imageUrl || null } : {}),
        },
        include: { provider: true },
      });
      await prisma.adminAuditLog.create({
        data: { adminId: jwt.sub, action: "GAME_UPDATE", target: id, payload: JSON.stringify(body) },
      });
      invalidateCatalog();
      return game;
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError("Já existe um jogo com esse slug", 409, "CONFLICT");
      throw e;
    }
  });

  // Exclusão definitiva só para jogo sem histórico; com sessões, o caminho é desativar.
  app.delete("/admin/games/:id", async (req) => {
    const jwt = await app.authenticate(req, [Role.ADMIN]);
    const { id } = idParamSchema.parse(req.params);
    const existing = await prisma.game.findUnique({ where: { id } });
    if (!existing) throw new AppError("Jogo não encontrado", 404, "NOT_FOUND");
    const sessions = await prisma.casinoSession.count({ where: { gameId: id } });
    if (sessions > 0) {
      throw new AppError("Este jogo tem sessões registradas — desative em vez de excluir", 409, "CONFLICT");
    }
    await prisma.game.delete({ where: { id } });
    await prisma.adminAuditLog.create({
      data: { adminId: jwt.sub, action: "GAME_DELETE", target: id, payload: existing.slug },
    });
    invalidateCatalog();
    return { ok: true };
  });

  /* ---------------------------- Eventos ---------------------------- */

  // Todos os eventos (inclui encerrados/cancelados), com total de seleções e quantas seguem abertas.
  app.get("/admin/events", async (req) => {
    await app.authenticate(req, adminRoles);
    const [events, open] = await Promise.all([
      prisma.sportEvent.findMany({
        orderBy: { startsAt: "asc" },
        include: { _count: { select: { selections: true } } },
      }),
      prisma.betSelection.groupBy({ by: ["eventId"], where: { status: "OPEN" }, _count: { _all: true } }),
    ]);
    const openBy = new Map(open.map((o) => [o.eventId, o._count._all]));
    return events.map(({ _count, ...e }) => ({ ...e, bets: _count.selections, openBets: openBy.get(e.id) ?? 0 }));
  });

  app.post("/admin/events", async (req) => {
    const jwt = await app.authenticate(req, [Role.ADMIN]);
    const { isLive, oddsDraw, ...body } = createEventSchema.parse(req.body);
    const event = await prisma.sportEvent.create({
      data: { ...body, oddsDraw: oddsDraw ?? null, isLive, status: isLive ? "LIVE" : "SCHEDULED" },
    });
    await prisma.adminAuditLog.create({
      data: {
        adminId: jwt.sub,
        action: "EVENT_CREATE",
        target: event.id,
        payload: JSON.stringify(req.body),
      },
    });
    return event;
  });

  app.patch("/admin/events/:id", async (req) => {
    const jwt = await app.authenticate(req, [Role.ADMIN]);
    const { id } = idParamSchema.parse(req.params);
    const body = updateEventSchema.parse(req.body);
    const existing = await prisma.sportEvent.findUnique({ where: { id } });
    if (!existing) throw new AppError("Evento não encontrado", 404, "NOT_FOUND");
    if (existing.status === "FINISHED" || existing.status === "CANCELLED") {
      throw new AppError("Evento encerrado ou cancelado não pode ser editado", 409, "EVENT_CLOSED");
    }
    const home = body.homeTeam ?? existing.homeTeam;
    const away = body.awayTeam ?? existing.awayTeam;
    if (home.toLowerCase() === away.toLowerCase()) throw new AppError("Os times precisam ser diferentes", 400);
    // Tirar o empate com apostas em empate abertas deixaria essas apostas sem como ganhar.
    if (body.oddsDraw === null && existing.oddsDraw != null) {
      const drawBets = await prisma.betSelection.count({ where: { eventId: id, selection: "draw", status: "OPEN" } });
      if (drawBets > 0) {
        throw new AppError("Há apostas em empate abertas neste evento — o empate não pode ser removido", 409, "CONFLICT");
      }
    }
    const { isLive, ...rest } = body;
    const event = await prisma.sportEvent.update({
      where: { id },
      data: { ...rest, ...(isLive !== undefined ? { isLive, status: isLive ? "LIVE" : "SCHEDULED" } : {}) },
    });
    await prisma.adminAuditLog.create({
      data: { adminId: jwt.sub, action: "EVENT_UPDATE", target: id, payload: JSON.stringify(req.body) },
    });
    return event;
  });

  // Cancelar: seleções abertas viram nulas; simples são devolvidas e acumuladas reavaliadas.
  app.post("/admin/events/:id/cancel", async (req) => {
    const jwt = await app.authenticate(req, [Role.ADMIN, Role.FINANCE]);
    const { id } = idParamSchema.parse(req.params);
    const result = await cancelEvent(id);
    await prisma.adminAuditLog.create({
      data: { adminId: jwt.sub, action: "EVENT_CANCEL", target: id, payload: JSON.stringify(result) },
    });
    return result;
  });

  // Exclusão definitiva só para evento sem apostas; com apostas, o caminho é cancelar.
  app.delete("/admin/events/:id", async (req) => {
    const jwt = await app.authenticate(req, [Role.ADMIN]);
    const { id } = idParamSchema.parse(req.params);
    const existing = await prisma.sportEvent.findUnique({ where: { id } });
    if (!existing) throw new AppError("Evento não encontrado", 404, "NOT_FOUND");
    const bets = await prisma.betSelection.count({ where: { eventId: id } });
    if (bets > 0) throw new AppError("Evento com apostas — cancele em vez de excluir", 409, "CONFLICT");
    await prisma.sportEvent.delete({ where: { id } });
    await prisma.adminAuditLog.create({
      data: {
        adminId: jwt.sub,
        action: "EVENT_DELETE",
        target: id,
        payload: `${existing.homeTeam} x ${existing.awayTeam}`,
      },
    });
    return { ok: true };
  });

  /* ---------------------- Integrações de cassino ---------------------- */

  // Status de cada agregador: jogos vindos dele, última sincronização e URL de callback a cadastrar lá.
  app.get("/admin/integrations", async (req) => {
    await app.authenticate(req, adminRoles);
    const base = `${req.protocol}://${req.headers.host}`;
    return Promise.all(
      listAdapters().map(async (a) => {
        const [games, activeGames, lastSync, sessions24h] = await Promise.all([
          prisma.game.count({ where: { integration: a.key } }),
          prisma.game.count({ where: { integration: a.key, isActive: true } }),
          prisma.adminAuditLog.findFirst({
            where: { action: "INTEGRATION_SYNC", target: a.key },
            orderBy: { createdAt: "desc" },
          }),
          prisma.casinoSession.count({
            where: { integration: a.key, startedAt: { gte: new Date(Date.now() - 86_400_000) } },
          }),
        ]);
        return {
          key: a.key,
          name: a.name,
          configured: a.configured(),
          // URLs dos webhooks de carteira a cadastrar no painel do agregador.
          webhooks: a.webhooks ? a.webhooks(base) : null,
          games,
          activeGames,
          sessions24h,
          lastSync: lastSync?.createdAt ?? null,
          lastSyncResult: lastSync?.payload ? JSON.parse(lastSync.payload) : null,
        };
      }),
    );
  });

  // Puxa o catálogo pela API do agregador e atualiza os jogos.
  app.post("/admin/integrations/:key/sync", async (req) => {
    const jwt = await app.authenticate(req, [Role.ADMIN]);
    const { key } = z.object({ key: z.string().min(1).max(40) }).parse(req.params);
    const adapter = getAdapter(key);
    if (!adapter) throw new AppError("Integração não encontrada", 404, "NOT_FOUND");
    // O catálogo da PlayFivers é público: sincroniza mesmo sem credenciais (elas só são exigidas para abrir o jogo).
    const result = await syncCatalog(adapter);
    // Com o token configurado, já confere quais carteiras a conta tem — o site só mostra essas.
    let wallets: { enabled: string[]; unmatched: string[] } | { error: string } | null = null;
    if (adapter.key === playfiversAdapter.key && adapter.configured()) {
      try {
        const w = await detectWallets(jwt.sub);
        wallets = { enabled: w.enabled, unmatched: w.unmatched };
      } catch (e) {
        wallets = { error: e instanceof Error ? e.message : "Falha ao ler as carteiras na PlayFivers" };
      }
    }
    await prisma.adminAuditLog.create({
      data: { adminId: jwt.sub, action: "INTEGRATION_SYNC", target: key, payload: JSON.stringify({ ...result, wallets }) },
    });
    startImageJob(); // capas de jogos novos: baixa e reduz em segundo plano
    return { ...result, wallets };
  });

  /* ── Carteiras habilitadas: o cassino mostra só os provedores que a conta da PlayFivers cobre ── */
  app.get("/admin/casino/wallets", async (req) => {
    await app.authenticate(req, adminRoles);
    return walletsOverview();
  });
  // Escolha manual (enquanto o token da PlayFivers não foi configurado em Ajustes → Instalação).
  app.put("/admin/casino/wallets", async (req) => {
    const jwt = await app.authenticate(req, [Role.ADMIN]);
    const { enabled } = casinoWalletsSchema.parse(req.body);
    await saveManualWallets(enabled, jwt.sub);
    startImageJob(); // carteira nova = jogos novos no site: baixa as capas deles
    return walletsOverview();
  });
  // Lê as carteiras do agente na PlayFivers (GET /api/v2/balances) e habilita exatamente elas.
  app.post("/admin/casino/wallets/detect", async (req) => {
    const jwt = await app.authenticate(req, [Role.ADMIN]);
    await detectWallets(jwt.sub);
    startImageJob();
    return walletsOverview();
  });

  /* ---------------- PlayFivers: agente (RTP/limites) e rodadas grátis ---------------- */

  const requirePlayfivers = () => {
    if (!playfiversAdapter.configured()) {
      throw new AppError("PlayFivers sem credenciais — configure em Ajustes → Instalação", 409, "NOT_CONFIGURED");
    }
  };

  app.get("/admin/playfivers/agent", async (req) => {
    await app.authenticate(req, adminRoles);
    requirePlayfivers();
    return playfiversAdapter.getAgent();
  });

  app.put("/admin/playfivers/agent", async (req) => {
    const jwt = await app.authenticate(req, [Role.ADMIN]);
    requirePlayfivers();
    const cfg = pfAgentUpdateSchema.parse(req.body);
    const result = await playfiversAdapter.updateAgent(cfg);
    await prisma.adminAuditLog.create({
      data: { adminId: jwt.sub, action: "PLAYFIVERS_AGENT_UPDATE", target: "agent", payload: JSON.stringify(cfg) },
    });
    return result;
  });

  app.get("/admin/playfivers/free-bonus", async (req) => {
    await app.authenticate(req, adminRoles);
    requirePlayfivers();
    return playfiversAdapter.listFreeBonus();
  });

  app.post("/admin/playfivers/free-bonus", async (req) => {
    const jwt = await app.authenticate(req, [Role.ADMIN]);
    requirePlayfivers();
    const body = pfFreeBonusGrantSchema.parse(req.body);
    // O admin escolhe um jogo sincronizado ("<provedor>:<código>"); a PlayFivers quer o código cru.
    let gameCode = body.game_code;
    const synced = await prisma.game.findUnique({
      where: { integration_externalId: { integration: playfiversAdapter.key, externalId: gameCode } },
      select: { meta: true },
    });
    if (synced?.meta) { try { gameCode = JSON.parse(synced.meta).code || gameCode; } catch { /* meta antigo */ } }
    const result = await playfiversAdapter.grantFreeBonus({
      userCode: body.user_code,
      gameCode,
      rounds: body.rounds,
    });
    await prisma.adminAuditLog.create({
      data: { adminId: jwt.sub, action: "PLAYFIVERS_FREEBONUS_GRANT", target: body.user_code, payload: JSON.stringify(body) },
    });
    return result;
  });

  app.delete("/admin/playfivers/free-bonus/:id", async (req) => {
    const jwt = await app.authenticate(req, [Role.ADMIN]);
    requirePlayfivers();
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const result = await playfiversAdapter.deleteFreeBonus(id);
    await prisma.adminAuditLog.create({
      data: { adminId: jwt.sub, action: "PLAYFIVERS_FREEBONUS_DELETE", target: String(id) },
    });
    return result;
  });

  // Liquidação de evento: define o resultado, marca seleções e paga bilhetes vencedores.
  app.post("/admin/events/:id/settle", async (req) => {
    const jwt = await app.authenticate(req, [Role.ADMIN, Role.FINANCE]);
    const { id } = idParamSchema.parse(req.params);
    const { outcome } = settleEventSchema.parse(req.body);
    const result = await settleEvent(id, outcome);
    await prisma.adminAuditLog.create({
      data: {
        adminId: jwt.sub,
        action: "EVENT_SETTLE",
        target: id,
        payload: JSON.stringify(result),
      },
    });
    return result;
  });

  /* ---------------------------- Banners ---------------------------- */

  // Lista todos os banners (inclui inativos) para o painel.
  app.get("/admin/banners", async (req) => {
    await app.authenticate(req, adminRoles);
    return prisma.banner.findMany({
      orderBy: [{ placement: "asc" }, { sortOrder: "asc" }, { createdAt: "asc" }],
    });
  });

  // Upload de imagem (data URL base64 → arquivo em /uploads). Limite de corpo ampliado.
  app.post(
    "/admin/banners/upload",
    { bodyLimit: 9 * 1024 * 1024 },
    async (req) => {
      const jwt = await app.authenticate(req, [Role.ADMIN]);
      const { dataUrl } = bannerUploadSchema.parse(req.body);
      const saved = saveDataUrl(dataUrl);
      await prisma.adminAuditLog.create({
        data: { adminId: jwt.sub, action: "BANNER_UPLOAD", target: saved.url },
      });
      return saved;
    },
  );

  app.post("/admin/banners", async (req) => {
    const jwt = await app.authenticate(req, [Role.ADMIN]);
    const body = createBannerSchema.parse(req.body);
    const banner = await prisma.banner.create({ data: body });
    await prisma.adminAuditLog.create({
      data: {
        adminId: jwt.sub,
        action: "BANNER_CREATE",
        target: banner.id,
        payload: JSON.stringify(body),
      },
    });
    return banner;
  });

  app.patch("/admin/banners/:id", async (req) => {
    const jwt = await app.authenticate(req, [Role.ADMIN]);
    const { id } = idParamSchema.parse(req.params);
    const body = updateBannerSchema.parse(req.body);
    const existing = await prisma.banner.findUnique({ where: { id } });
    if (!existing) throw new AppError("Banner não encontrado", 404, "NOT_FOUND");
    const banner = await prisma.banner.update({ where: { id }, data: body });
    await prisma.adminAuditLog.create({
      data: {
        adminId: jwt.sub,
        action: "BANNER_UPDATE",
        target: id,
        payload: JSON.stringify(body),
      },
    });
    return banner;
  });

  app.delete("/admin/banners/:id", async (req) => {
    const jwt = await app.authenticate(req, [Role.ADMIN]);
    const { id } = idParamSchema.parse(req.params);
    const existing = await prisma.banner.findUnique({ where: { id } });
    if (!existing) throw new AppError("Banner não encontrado", 404, "NOT_FOUND");
    await prisma.banner.delete({ where: { id } });
    await prisma.adminAuditLog.create({
      data: { adminId: jwt.sub, action: "BANNER_DELETE", target: id },
    });
    return { ok: true };
  });

  /* --------------------------- Provedores --------------------------- */

  // Lista provedores com quantidade de jogos, para o painel.
  app.get("/admin/providers", async (req) => {
    await app.authenticate(req, adminRoles);
    const rows = await prisma.gameProvider.findMany({
      orderBy: { name: "asc" },
      include: { _count: { select: { games: true } } },
    });
    return rows.map(({ _count, ...p }) => ({ ...p, games: _count.games }));
  });

  app.patch("/admin/providers/:id", async (req) => {
    const jwt = await app.authenticate(req, [Role.ADMIN]);
    const { id } = idParamSchema.parse(req.params);
    const body = patchProviderSchema.parse(req.body);
    const existing = await prisma.gameProvider.findUnique({ where: { id } });
    if (!existing) throw new AppError("Provedor não encontrado", 404, "NOT_FOUND");
    const provider = await prisma.gameProvider.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.logoUrl !== undefined ? { logoUrl: body.logoUrl || null } : {}),
      },
    });
    await prisma.adminAuditLog.create({
      data: {
        adminId: jwt.sub,
        action: "PROVIDER_UPDATE",
        target: id,
        payload: JSON.stringify(body),
      },
    });
    invalidateCatalog();
    return provider;
  });

  // Envia o logo (data URL) e já aplica no provedor.
  app.post(
    "/admin/providers/:id/logo",
    { bodyLimit: 9 * 1024 * 1024 },
    async (req) => {
      const jwt = await app.authenticate(req, [Role.ADMIN]);
      const { id } = idParamSchema.parse(req.params);
      const { dataUrl } = imageUploadSchema.parse(req.body);
      const existing = await prisma.gameProvider.findUnique({ where: { id } });
      if (!existing) throw new AppError("Provedor não encontrado", 404, "NOT_FOUND");
      const saved = saveDataUrl(dataUrl, "provider");
      const provider = await prisma.gameProvider.update({
        where: { id },
        data: { logoUrl: saved.url },
      });
      await prisma.adminAuditLog.create({
        data: { adminId: jwt.sub, action: "PROVIDER_LOGO", target: id, payload: saved.url },
      });
      invalidateCatalog();
      return provider;
    },
  );
}