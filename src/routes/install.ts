import type { FastifyInstance, FastifyRequest } from "fastify";
import { Role } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";
import { installPlayfiversSchema } from "../schemas/index.js";
import { publicInstallView, savePlayfiversInstall, invalidIps } from "../services/install-config.js";
import { playfiversAdapter } from "../casino/adapters/playfivers.js";
import { detectWallets } from "../services/casino-wallets.js";

const admin: Role[] = [Role.ADMIN];

/**
 * Ajustes → Instalação: configuração do servidor guardada no banco, só para administrador.
 * Token e segredo nunca voltam para o navegador (só "definido" e os 4 últimos caracteres).
 */
export async function installRoutes(app: FastifyInstance) {
  const view = async (req: FastifyRequest) => {
    const base = `${req.protocol}://${req.headers.host}`;
    const v = publicInstallView();
    const by = v.updatedBy ? await prisma.user.findUnique({ where: { id: v.updatedBy }, select: { email: true } }) : null;
    return { ...v, updatedByEmail: by?.email ?? null, webhooks: playfiversAdapter.webhooks?.(base) ?? [] };
  };

  app.get("/admin/install", async (req) => {
    await app.authenticate(req, admin);
    return view(req);
  });

  app.put("/admin/install/playfivers", async (req) => {
    const jwt = await app.authenticate(req, admin);
    const body = installPlayfiversSchema.parse(req.body);
    if (body.ipAllowlist) {
      const bad = invalidIps(body.ipAllowlist);
      if (bad.length) throw new AppError(`IP inválido: ${bad.join(", ")}`, 400, "INVALID_IP");
    }
    await savePlayfiversInstall(body, jwt.sub);
    return view(req);
  });

  // Testa as credenciais salvas lendo o agente na PlayFivers; se der certo, já lê as carteiras da conta
  // (o site passa a mostrar exatamente o que a conta cobre).
  app.post("/admin/install/playfivers/test", async (req) => {
    const jwt = await app.authenticate(req, admin);
    if (!playfiversAdapter.configured()) {
      throw new AppError("Preencha o token e o segredo do agente e salve antes de testar.", 409, "NOT_CONFIGURED");
    }
    const agent = await playfiversAdapter.getAgent(); // erro da PlayFivers volta com a mensagem deles
    let wallets: { enabled: string[]; unmatched: string[] } | { error: string };
    try {
      const w = await detectWallets(jwt.sub);
      wallets = { enabled: w.enabled, unmatched: w.unmatched };
    } catch (e) {
      wallets = { error: e instanceof Error ? e.message : "Falha ao ler as carteiras na PlayFivers" };
    }
    await prisma.adminAuditLog.create({ data: { adminId: jwt.sub, action: "INSTALL_PLAYFIVERS_TEST", target: "install", payload: JSON.stringify({ ok: true }) } });
    return { ok: true, agent: { rtp: agent.rtp, limit_enable: agent.limit_enable, bonus_enable: agent.bonus_enable }, wallets };
  });
}
