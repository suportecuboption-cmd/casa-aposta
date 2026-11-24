import type { FastifyInstance, FastifyRequest } from "fastify";
import { Role } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";
import { paymentsActiveSchema, paymentsSettingsSchema, gatewayConfigSchema, gatewayParamSchema } from "../schemas/index.js";
import { publicPaymentsView, setActiveGateway, setPublicBaseUrl, saveGatewayCreds, gatewayConfigured } from "../payments/config.js";
import { GATEWAYS, webhookPath } from "../payments/registry.js";

const admin: Role[] = [Role.ADMIN];

/** Admin → Pagamentos → Gateways. Só administrador; segredos nunca voltam para o navegador. */
export async function paymentsAdminRoutes(app: FastifyInstance) {
  const view = async (req: FastifyRequest) => {
    const v = publicPaymentsView();
    const reqBase = `${req.protocol}://${req.headers.host}`;
    const base = v.publicBaseUrl || reqBase;
    const by = v.updatedBy ? await prisma.user.findUnique({ where: { id: v.updatedBy }, select: { email: true } }) : null;
    return {
      ...v,
      updatedByEmail: by?.email ?? null,
      suggestedBase: reqBase,
      gateways: v.gateways.map((g) => ({
        ...g,
        name: GATEWAYS[g.key].name,
        site: GATEWAYS[g.key].site,
        webhookHelp: GATEWAYS[g.key].webhookHelp,
        webhookUrl: `${base}${webhookPath(g.key)}`,
        active: v.active === g.key,
      })),
    };
  };

  app.get("/admin/payments", async (req) => {
    await app.authenticate(req, admin);
    return view(req);
  });

  // Um clique: ativa um gateway (ou volta ao modo manual com active = null).
  app.put("/admin/payments/active", async (req) => {
    const jwt = await app.authenticate(req, admin);
    const { active } = paymentsActiveSchema.parse(req.body);
    if (active && !gatewayConfigured(active)) {
      throw new AppError(`Configure as credenciais da ${GATEWAYS[active].name} antes de ativar.`, 400, "NOT_CONFIGURED");
    }
    await setActiveGateway(active, jwt.sub);
    return view(req);
  });

  app.put("/admin/payments/settings", async (req) => {
    const jwt = await app.authenticate(req, admin);
    const { publicBaseUrl } = paymentsSettingsSchema.parse(req.body);
    await setPublicBaseUrl(publicBaseUrl, jwt.sub);
    return view(req);
  });

  app.put("/admin/payments/gateways/:key", async (req) => {
    const jwt = await app.authenticate(req, admin);
    const { key } = gatewayParamSchema.parse(req.params);
    const { values, clear } = gatewayConfigSchema.parse(req.body);
    await saveGatewayCreds(key, values, !!clear, jwt.sub);
    return view(req);
  });

  // Testa as credenciais lendo o saldo no gateway.
  app.post("/admin/payments/gateways/:key/test", async (req) => {
    const jwt = await app.authenticate(req, admin);
    const { key } = gatewayParamSchema.parse(req.params);
    if (!gatewayConfigured(key)) throw new AppError("Preencha e salve as credenciais antes de testar.", 409, "NOT_CONFIGURED");
    let balance: number | null;
    try {
      balance = await GATEWAYS[key].balance();
    } catch (e) {
      throw new AppError(e instanceof Error ? e.message : "Falha na conexão com o gateway", 502, "GATEWAY_ERROR");
    }
    await prisma.adminAuditLog.create({ data: { adminId: jwt.sub, action: "PAYMENTS_GATEWAY_TEST", target: key, payload: JSON.stringify({ ok: true }) } });
    return { ok: true, balance };
  });
}
