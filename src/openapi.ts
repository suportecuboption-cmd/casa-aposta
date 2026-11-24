import { zodToJsonSchema } from "./lib/zod-to-jsonschema.js";
import {
  registerSchema,
  loginSchema,
  depositSchema,
  withdrawSchema,
  gamesQuerySchema,
  placeBetslipSchema,
  settleEventSchema,
  patchUserSchema,
  pixQuerySchema,
  createGameSchema,
  updateGameSchema,
  imageUploadSchema,
  bannerQuerySchema,
  createBannerSchema,
  updateBannerSchema,
  patchProviderSchema,
  createEventSchema,
  updateEventSchema,
  launchSchema,
  winsFeedConfigSchema,
  pfBalanceWebhookSchema,
  pfTxnTopSchema,
  dashboardParamsSchema,
} from "./schemas/index.js";

const periodParams = [
  { name: "from", in: "query", required: false, schema: { type: "string", format: "date" }, description: "AAAA-MM-DD (fuso de São Paulo); padrão: 6 dias antes de 'to'" },
  { name: "to", in: "query", required: false, schema: { type: "string", format: "date" }, description: "AAAA-MM-DD, inclusive; padrão: hoje" },
];

const bearer = [{ bearerAuth: [] }];

// Dashboard (modelo Axio): se o período inclui hoje, termina agora; o anterior tem a mesma duração.
const dashParams = [
  { name: "from", in: "query", required: false, schema: { type: "string", format: "date" }, description: "AAAA-MM-DD (São Paulo); padrão: hoje" },
  { name: "to", in: "query", required: false, schema: { type: "string", format: "date" }, description: "AAAA-MM-DD, inclusive; padrão: hoje" },
  { name: "mode", in: "query", required: false, schema: { type: "string", enum: ["native", "usd"] }, description: "native = Nativa (só a moeda escolhida); usd = USD Geral (todas, convertidas)" },
  { name: "cur", in: "query", required: false, schema: { type: "string", enum: ["BRL", "USD"] }, description: "Moeda dos valores" },
];

function jsonBody(schema: object) {
  return {
    required: true,
    content: { "application/json": { schema } },
  };
}

function queryParams(schema: { properties?: Record<string, object>; required?: string[] }) {
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  return Object.entries(props).map(([name, s]) => ({
    name,
    in: "query",
    required: required.has(name),
    schema: s,
  }));
}

const idPathParam = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string" },
};

const ok = { description: "OK" };

/**
 * Documento OpenAPI 3.0 derivado dos schemas Zod reais (fonte única de verdade).
 */
export const openapiDocument = {
  openapi: "3.0.3",
  info: {
    title: "casa-aposta API (lab)",
    version: "0.1.0",
    description:
      "Backend educacional (Fastify + Prisma + SQLite). Pagamentos são simulados (mock), sem provedor real.",
  },
  servers: [{ url: "/" }],
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
    },
  },
  paths: {
    "/health": {
      get: { summary: "Healthcheck", responses: { "200": ok } },
    },
    "/auth/register": {
      post: {
        summary: "Criar conta de jogador",
        requestBody: jsonBody(zodToJsonSchema(registerSchema)),
        responses: { "200": ok, "409": { description: "Email já registado" } },
      },
    },
    "/auth/login": {
      post: {
        summary: "Login",
        requestBody: jsonBody(zodToJsonSchema(loginSchema)),
        responses: { "200": ok, "401": { description: "Credenciais inválidas" } },
      },
    },
    "/auth/me": {
      get: {
        summary: "Perfil autenticado",
        security: bearer,
        responses: { "200": ok, "401": { description: "Não autorizado" } },
      },
    },
    "/wallet": {
      get: {
        summary: "Saldo da carteira",
        security: bearer,
        responses: { "200": ok, "401": { description: "Não autorizado" } },
      },
    },
    "/wallet/transactions": {
      get: {
        summary: "Últimas transações",
        security: bearer,
        responses: { "200": ok },
      },
    },
    "/wallet/deposit/pix": {
      post: {
        summary: "Criar ordem de depósito PIX (mock)",
        security: bearer,
        requestBody: jsonBody(zodToJsonSchema(depositSchema)),
        responses: { "200": ok, "400": { description: "Validação" } },
      },
    },
    "/wallet/withdraw/pix": {
      post: {
        summary: "Solicitar saque PIX (mock)",
        security: bearer,
        requestBody: jsonBody(zodToJsonSchema(withdrawSchema)),
        responses: { "200": ok, "400": { description: "Saldo insuficiente / validação" } },
      },
    },
    "/games": {
      get: {
        summary: "Catálogo de jogos ativos",
        parameters: queryParams(zodToJsonSchema(gamesQuerySchema) as any),
        responses: { "200": ok },
      },
    },
    "/sports": {
      get: { summary: "Eventos esportivos", responses: { "200": ok } },
    },
    "/banners": {
      get: {
        summary: "Banners ativos da home (carrossel e laterais)",
        parameters: queryParams(zodToJsonSchema(bannerQuerySchema) as any),
        responses: { "200": ok },
      },
    },
    "/wins/recent": {
      get: {
        summary: "Grandes vitórias recentes: só prêmios pagos de verdade, nome mascarado, sem dados do jogador (cache de 10 s)",
        responses: { "200": { description: "{ enabled, items: [{ key, player, product, title, detail, gameId, imageUrl, amount, multiplier, at }] }" } },
      },
    },
    "/betslips": {
      post: {
        summary: "Montar bilhete (simples = 1 seleção, acumulada = 2+)",
        security: bearer,
        requestBody: jsonBody(zodToJsonSchema(placeBetslipSchema)),
        responses: { "200": ok, "400": { description: "Saldo insuficiente / validação" } },
      },
    },
    "/betslips/mine": {
      get: {
        summary: "Meus bilhetes",
        security: bearer,
        responses: { "200": ok },
      },
    },
    "/betslips/{id}": {
      get: {
        summary: "Detalhe do bilhete",
        security: bearer,
        parameters: [idPathParam],
        responses: { "200": ok, "404": { description: "Não encontrado" } },
      },
    },
    "/api/admin/dashboard": {
      get: { summary: "Métricas (admin)", security: bearer, responses: { "200": ok } },
    },
    "/api/admin/users": {
      get: { summary: "Listar usuários (admin)", security: bearer, responses: { "200": ok } },
    },
    "/api/admin/users/{id}": {
      patch: {
        summary: "Atualizar usuário (admin)",
        security: bearer,
        parameters: [idPathParam],
        requestBody: jsonBody(zodToJsonSchema(patchUserSchema)),
        responses: { "200": ok },
      },
    },
    "/api/admin/pix": {
      get: {
        summary: "Listar ordens PIX (admin/finance)",
        security: bearer,
        parameters: queryParams(zodToJsonSchema(pixQuerySchema) as any),
        responses: { "200": ok },
      },
    },
    "/api/admin/pix/{id}/approve": {
      post: {
        summary: "Aprovar ordem PIX (mock)",
        security: bearer,
        parameters: [idPathParam],
        responses: { "200": ok },
      },
    },
    "/api/admin/games": {
      get: { summary: "Listar todos os jogos, inclusive inativos (admin)", security: bearer, responses: { "200": ok } },
      post: {
        summary: "Cadastrar jogo (admin)",
        security: bearer,
        requestBody: jsonBody(zodToJsonSchema(createGameSchema)),
        responses: { "200": ok, "409": { description: "Slug já usado" } },
      },
    },
    "/api/admin/games/{id}": {
      patch: {
        summary: "Editar jogo (admin)",
        security: bearer,
        parameters: [idPathParam],
        requestBody: jsonBody(zodToJsonSchema(updateGameSchema)),
        responses: { "200": ok, "404": { description: "Não encontrado" }, "409": { description: "Slug já usado" } },
      },
      delete: {
        summary: "Excluir jogo sem sessões (admin)",
        security: bearer,
        parameters: [idPathParam],
        responses: { "200": ok, "409": { description: "Jogo com sessões — desative" } },
      },
    },
    "/api/admin/games/upload": {
      post: {
        summary: "Enviar imagem de card de jogo (data URL) → URL em /uploads",
        security: bearer,
        requestBody: jsonBody(zodToJsonSchema(imageUploadSchema)),
        responses: { "200": ok },
      },
    },
    "/api/admin/banners": {
      get: { summary: "Listar banners, inclusive inativos (admin)", security: bearer, responses: { "200": ok } },
      post: {
        summary: "Criar banner (admin)",
        security: bearer,
        requestBody: jsonBody(zodToJsonSchema(createBannerSchema)),
        responses: { "200": ok },
      },
    },
    "/api/admin/banners/{id}": {
      patch: {
        summary: "Editar banner (admin)",
        security: bearer,
        parameters: [idPathParam],
        requestBody: jsonBody(zodToJsonSchema(updateBannerSchema)),
        responses: { "200": ok },
      },
      delete: { summary: "Excluir banner (admin)", security: bearer, parameters: [idPathParam], responses: { "200": ok } },
    },
    "/api/admin/banners/upload": {
      post: {
        summary: "Enviar imagem de banner (data URL) → URL em /uploads",
        security: bearer,
        requestBody: jsonBody(zodToJsonSchema(imageUploadSchema)),
        responses: { "200": ok },
      },
    },
    "/api/admin/providers": {
      get: { summary: "Listar provedores com contagem de jogos (admin)", security: bearer, responses: { "200": ok } },
    },
    "/api/admin/providers/{id}": {
      patch: {
        summary: "Editar nome/logo do provedor (admin)",
        security: bearer,
        parameters: [idPathParam],
        requestBody: jsonBody(zodToJsonSchema(patchProviderSchema)),
        responses: { "200": ok },
      },
    },
    "/api/admin/providers/{id}/logo": {
      post: {
        summary: "Enviar logo do provedor (data URL) e aplicar",
        security: bearer,
        parameters: [idPathParam],
        requestBody: jsonBody(zodToJsonSchema(imageUploadSchema)),
        responses: { "200": ok },
      },
    },
    "/casino/launch": {
      post: {
        summary: "Abrir jogo da PlayFivers: devolve a URL do iframe (exige login; a PlayFivers não tem demo)",
        requestBody: jsonBody(zodToJsonSchema(launchSchema)),
        responses: { "200": ok, "401": { description: "Sem login" }, "409": { description: "Jogo indisponível (sem credenciais da PlayFivers)" } },
      },
    },
    "/playfivers/callback": {
      post: {
        summary:
          "PlayFivers → nós: callback único do agente (também atende em POST / e nas rotas antigas /webhook e /api/webhook). " +
          "O campo type separa: BALANCE (saldo) ou WinBet/Refund (transação, com agent_code/agent_secret). Devolve { msg, balance }",
        responses: {
          "200": { description: "{ msg: '', balance }" },
          "400": { description: "{ msg: INSUFFICIENT_USER_FUNDS | INVALID_REQUEST, balance }" },
          "401": { description: "{ msg: INVALID_AGENT } — agent_secret/agent_code não conferem" },
          "403": { description: "IP não autorizado" },
          "404": { description: "{ msg: INVALID_USER, balance: 0 }" },
          "500": { description: "{ msg: ERROR_INTERNAL, balance: 0 }" },
        },
      },
    },
    "/webhook": {
      post: {
        summary: "PlayFivers → nós: saldo do jogador (seamless). Auth por IP whitelist. Devolve { msg, balance }",
        requestBody: jsonBody(zodToJsonSchema(pfBalanceWebhookSchema)),
        responses: { "200": { description: "{ msg, balance }" }, "403": { description: "IP não autorizado" }, "404": { description: "Usuário não encontrado" } },
      },
    },
    "/api/webhook": {
      post: {
        summary: "PlayFivers → nós: transação (WinBet) ou estorno (Refund). Auth por IP + agent_code/agent_secret. O objeto da rodada vem em 'slot'",
        requestBody: jsonBody(zodToJsonSchema(pfTxnTopSchema)),
        responses: {
          "200": { description: "{ msg, balance } — txn_id repetido não aplica de novo" },
          "400": { description: "Saldo insuficiente" },
          "401": { description: "Credenciais inválidas" },
          "403": { description: "IP não autorizado" },
          "404": { description: "Usuário não encontrado" },
        },
      },
    },
    "/api/admin/reports/summary": {
      get: { summary: "Dashboard: GGR, RTP, NGR, depósitos/saques, jogadores, passivos e série diária (admin/finance)", security: bearer, parameters: periodParams, responses: { "200": ok } },
    },
    "/api/admin/reports/casino": {
      get: { summary: "Cassino por jogo e provedor: rodadas, jogadores, apostas, prêmios, GGR, RTP (admin/finance)", security: bearer, parameters: periodParams, responses: { "200": ok } },
    },
    "/api/admin/reports/sports": {
      get: { summary: "Bilhetes por situação e por tipo (admin/finance)", security: bearer, parameters: periodParams, responses: { "200": ok } },
    },
    "/api/admin/dash/summary": {
      get: {
        summary: "Dashboard (Visão Geral, Pagamentos, Carteira & Moedas, Cassino & Jogadores): período atual + anterior, carteira agora e tabelas por moeda (admin/finance)",
        security: bearer, parameters: dashParams,
        responses: { "200": ok, "409": { description: "FX_MISSING — defina a cotação do dólar nos parâmetros" } },
      },
    },
    "/api/admin/dash/casino": {
      get: { summary: "Dashboard → Provedores e Jogos: resultado do cassino por provedor e por jogo (admin/finance)", security: bearer, parameters: dashParams, responses: { "200": ok } },
    },
    "/api/admin/dash/sports": {
      get: { summary: "Dashboard → Esportes: resultado dos bilhetes, apostas em aberto, por situação e tipo (admin/finance)", security: bearer, parameters: dashParams, responses: { "200": ok } },
    },
    "/api/admin/dash/wallets": {
      get: { summary: "Dashboard → carteiras pré-pagas do agregador (PlayFivers) com GGR % e saldo mínimo (admin/finance)", security: bearer, parameters: dashParams, responses: { "200": ok } },
    },
    "/api/admin/dash/params": {
      get: { summary: "Parâmetros do dashboard: cotação do dólar, URL do painel do agregador, GGR % e saldo mínimo por carteira", security: bearer, responses: { "200": ok } },
      put: { summary: "Salvar parâmetros do dashboard (admin) — auditoria DASHBOARD_PARAMS_UPDATE", security: bearer, requestBody: jsonBody(zodToJsonSchema(dashboardParamsSchema)), responses: { "200": ok } },
    },
    "/api/admin/integrations": {
      get: { summary: "Integrações de cassino: jogos, última sincronização, URL de callback (admin)", security: bearer, responses: { "200": ok } },
    },
    "/api/admin/integrations/{key}/sync": {
      post: {
        summary: "Sincronizar catálogo de jogos pela API do agregador (admin)",
        security: bearer,
        parameters: [{ name: "key", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": ok },
      },
    },
    "/api/admin/users/{id}/adjust": {
      post: {
        summary: "Ajuste manual de saldo com motivo (admin/finance); não deixa saldo negativo",
        security: bearer,
        parameters: [idPathParam],
        requestBody: jsonBody({ type: "object", required: ["amount", "reason"], properties: { amount: { type: "number" }, reason: { type: "string", minLength: 3, maxLength: 200 } } }),
        responses: { "200": ok, "400": { description: "Saldo insuficiente / validação" } },
      },
    },
    "/api/admin/pix/{id}/reject": {
      post: {
        summary: "Recusar ordem PIX pendente com motivo (admin/finance)",
        security: bearer,
        parameters: [idPathParam],
        requestBody: jsonBody({ type: "object", required: ["reason"], properties: { reason: { type: "string", minLength: 3, maxLength: 200 } } }),
        responses: { "200": ok, "400": { description: "Ordem já processada" } },
      },
    },
    "/api/admin/pix/summary": {
      get: { summary: "Totais de PIX pendentes e pagos (admin/finance)", security: bearer, responses: { "200": ok } },
    },
    "/api/admin/betslips": {
      get: { summary: "Bilhetes de esportes com filtros por situação e e-mail (equipe)", security: bearer, responses: { "200": ok } },
    },
    "/api/admin/audit": {
      get: { summary: "Log de auditoria: quem fez o quê e quando (admin)", security: bearer, responses: { "200": ok } },
    },
    "/api/admin/wins-feed": {
      get: { summary: "Vitórias recentes: ajustes salvos + o que o site mostra agora, com e-mail e aposta (equipe)", security: bearer, responses: { "200": ok } },
      put: {
        summary: "Salvar ajustes das vitórias recentes; vale na hora e vai para a auditoria (admin)",
        security: bearer,
        requestBody: jsonBody(zodToJsonSchema(winsFeedConfigSchema)),
        responses: { "200": ok, "400": { description: "Validação" }, "403": { description: "Só administradores" } },
      },
    },
    "/api/admin/wins-feed/preview": {
      post: {
        summary: "Testar ajustes sem salvar: devolve a lista que o site mostraria (equipe)",
        security: bearer,
        requestBody: jsonBody(zodToJsonSchema(winsFeedConfigSchema)),
        responses: { "200": ok, "400": { description: "Validação" } },
      },
    },
    "/api/admin/events": {
      get: {
        summary: "Listar eventos, inclusive encerrados/cancelados, com contagem de apostas (admin)",
        security: bearer,
        responses: { "200": ok },
      },
      post: {
        summary: "Criar evento esportivo (admin)",
        security: bearer,
        requestBody: jsonBody(zodToJsonSchema(createEventSchema)),
        responses: { "200": ok },
      },
    },
    "/api/admin/events/{id}": {
      patch: {
        summary: "Editar evento aberto: times, horário, odds, ao vivo (admin)",
        security: bearer,
        parameters: [idPathParam],
        requestBody: jsonBody(zodToJsonSchema(updateEventSchema)),
        responses: { "200": ok, "409": { description: "Evento encerrado/cancelado ou empate com apostas" } },
      },
      delete: {
        summary: "Excluir evento sem apostas (admin)",
        security: bearer,
        parameters: [idPathParam],
        responses: { "200": ok, "409": { description: "Evento com apostas — cancele" } },
      },
    },
    "/api/admin/events/{id}/cancel": {
      post: {
        summary: "Cancelar evento: anula seleções abertas, devolve simples e reavalia acumuladas (admin/finance)",
        security: bearer,
        parameters: [idPathParam],
        responses: { "200": ok },
      },
    },
    "/api/admin/events/{id}/settle": {
      post: {
        summary: "Liquidar evento e pagar bilhetes (admin/finance)",
        security: bearer,
        parameters: [idPathParam],
        requestBody: jsonBody(zodToJsonSchema(settleEventSchema)),
        responses: { "200": ok },
      },
    },
  },
} as const;
