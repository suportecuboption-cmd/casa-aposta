import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import fastifyStatic from "@fastify/static";
import { ZodError } from "zod";
import { AppError } from "./lib/errors.js";
import { registerAuth } from "./plugins/auth.js";
import { openapiDocument } from "./openapi.js";
import { authRoutes } from "./routes/auth.js";
import { walletRoutes } from "./routes/wallet.js";
import { meRoutes } from "./routes/me.js";
import { catalogRoutes } from "./routes/catalog.js";
import { betslipRoutes } from "./routes/betslips.js";
import { adminRoutes } from "./routes/admin.js";
import { bannerRoutes } from "./routes/banners.js";
import { casinoRoutes } from "./routes/casino.js";
import { playfiversWebhookRoutes } from "./routes/playfivers.js";
import { reportRoutes } from "./routes/reports.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { opsRoutes } from "./routes/ops.js";
import { adminOpsRoutes } from "./routes/admin-ops.js";
import { winsRoutes, winsAdminRoutes } from "./routes/wins.js";
import { installRoutes } from "./routes/install.js";
import { loadInstallConfig } from "./services/install-config.js";
import { loadPaymentsConfig } from "./payments/config.js";
import { paymentsAdminRoutes } from "./routes/payments-admin.js";
import { paymentsWebhookRoutes } from "./routes/payments-webhooks.js";
import { gameImagesRoutes } from "./routes/game-images.js";
import { siteRoutes, siteAdminRoutes } from "./routes/site.js";
import { loyaltyRoutes, loyaltyAdminRoutes } from "./routes/loyalty.js";
import { incentiveRoutes, incentiveAdminRoutes } from "./routes/incentives.js";
import { startIncentiveSweeper, stopIncentiveSweeper } from "./services/incentives.js";
import { loadBrandConfig } from "./services/brand.js";
import { GAME_THUMBS_DIR, ensureThumbsDir } from "./services/game-images.js";
import { uploadsDir, ensureUploadsDir } from "./lib/uploads.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type ClientError = { statusCode: number; code?: string; message: string };
function isClientError(e: unknown): e is ClientError {
  if (typeof e !== "object" || e === null) return false;
  const status = (e as { statusCode?: unknown }).statusCode;
  return typeof status === "number" && status >= 400 && status < 500;
}

export function buildApp() {
  const app = Fastify({ logger: true });

  app.register(cors, { origin: true });
  app.register(jwt, {
    secret: process.env.JWT_SECRET ?? "dev-secret-change-me",
  });
  registerAuth(app);
  // Configurações no banco (credenciais da PlayFivers, gateways de pagamento, marca do site): carregam ao subir.
  app.addHook("onReady", async () => {
    await Promise.all([loadInstallConfig(), loadPaymentsConfig(), loadBrandConfig()]);
    // Incentivos vencidos: encerra a cada minuto (o saldo de bônus que sobrou é retirado).
    startIncentiveSweeper((msg, err) => app.log.warn({ err }, msg));
  });
  app.addHook("onClose", async () => stopIncentiveSweeper());

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: err.code, message: err.message });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: "VALIDATION",
        message: "Dados inválidos",
        issues: err.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    }
    // Erros do próprio Fastify com status 4xx (JSON inválido, corpo vazio, corpo grande demais…)
    // são do cliente: devolve o status certo em vez de mascarar como 500.
    if (isClientError(err)) {
      return reply.status(err.statusCode).send({ error: err.code ?? "BAD_REQUEST", message: err.message });
    }
    app.log.error(err);
    return reply.status(500).send({ error: "INTERNAL", message: "Erro interno" });
  });

  app.register(authRoutes);
  app.register(walletRoutes);
  app.register(meRoutes);
  app.register(catalogRoutes);
  app.register(bannerRoutes);
  app.register(winsRoutes);
  app.register(casinoRoutes);
  app.register(playfiversWebhookRoutes); // carteira dos jogos: callback seamless da PlayFivers (/playfivers/callback, / e rotas antigas)
  app.register(paymentsWebhookRoutes); // avisos dos gateways de pagamento (/payments/webhook/:gateway)
  app.register(betslipRoutes);
  app.register(siteRoutes); // marca pública (/site/brand) e a página do site já com a marca (/app/)
  app.register(loyaltyRoutes); // Nível VIP e Coleções do jogador (/vip, /collections)
  app.register(incentiveRoutes); // Incentivos do jogador: campanhas, bônus com rollover (/incentives)
  app.register(adminRoutes, { prefix: "/api" });
  app.register(reportRoutes, { prefix: "/api" });
  app.register(dashboardRoutes, { prefix: "/api" });
  app.register(opsRoutes, { prefix: "/api" });
  app.register(adminOpsRoutes, { prefix: "/api" });
  app.register(winsAdminRoutes, { prefix: "/api" });
  app.register(installRoutes, { prefix: "/api" });
  app.register(paymentsAdminRoutes, { prefix: "/api" });
  app.register(gameImagesRoutes, { prefix: "/api" });
  app.register(siteAdminRoutes, { prefix: "/api" });
  app.register(loyaltyAdminRoutes, { prefix: "/api" });
  app.register(incentiveAdminRoutes, { prefix: "/api" });

  app.register(fastifyStatic, {
    root: path.join(__dirname, "..", "admin-ui"),
    prefix: "/admin/",
  });

  // Imagens de banner enviadas pelo admin.
  ensureUploadsDir();
  app.register(fastifyStatic, {
    root: uploadsDir,
    prefix: "/uploads/",
    decorateReply: false,
  });
  // Miniaturas das capas dos jogos: o nome leva o hash do conteúdo → cache de 1 ano no navegador.
  ensureThumbsDir();
  app.register(fastifyStatic, {
    root: GAME_THUMBS_DIR,
    prefix: "/uploads/games/",
    decorateReply: false,
    maxAge: "365d",
    immutable: true,
  });

  app.get("/health", async () => ({ ok: true, service: "casa-aposta" }));

  app.get("/openapi.json", async () => openapiDocument);

  app.register(fastifyStatic, {
    root: path.join(__dirname, "..", "player-ui"),
    prefix: "/app/",
    decorateReply: false,
  });

  return app;
}