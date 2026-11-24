import type { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";
import { isGatewayKey, type GatewayKey } from "../payments/config.js";
import { GATEWAYS } from "../payments/registry.js";
import { clientIp } from "../payments/http.js";
import { settleDeposit, expireDeposit, settlePayout, failPayout } from "../services/pix-settle.js";

/**
 * Avisos (webhooks) dos gateways de pagamento: POST /payments/webhook/:gateway.
 * O corpo é lido CRU (a SwytchPay assina o texto exato) e o IP real atrás do túnel vem do cabeçalho.
 * Responde 2xx para aviso tratado, repetido ou desconhecido (senão o gateway reenvia sem parar) e 5xx
 * só em erro nosso — aí o gateway tenta de novo.
 */
export async function paymentsWebhookRoutes(app: FastifyInstance) {
  app.register(async (scope) => {
    // Só neste escopo: guarda o corpo cru antes de interpretar o JSON.
    scope.removeContentTypeParser("application/json");
    scope.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
      const raw = typeof body === "string" ? body : body.toString("utf8");
      (req as { rawBody?: string }).rawBody = raw;
      if (!raw) return done(null, {});
      try {
        done(null, JSON.parse(raw));
      } catch {
        done(Object.assign(new Error("JSON inválido"), { statusCode: 400 }), undefined);
      }
    });

    scope.post("/payments/webhook/:gateway", async (req, reply) => {
      const key = (req.params as { gateway?: string }).gateway;
      if (!isGatewayKey(key)) return reply.status(404).send({ ok: false });
      const gw = GATEWAYS[key];
      const ip = clientIp(req.ip, req.headers);
      const v = gw.verifyWebhook({ ip, headers: req.headers, rawBody: (req as { rawBody?: string }).rawBody ?? "" });
      if (!v.ok) {
        req.log.warn({ gateway: key, ip, reason: v.reason }, "aviso de pagamento recusado");
        return reply.status(401).send({ ok: false });
      }
      const ev = gw.parseWebhook(req.body);
      if (ev.kind === "ignored") {
        req.log.info({ gateway: key, event: ev.event }, "aviso de pagamento ignorado");
        return { ok: true };
      }
      const order = await findOrder(key, ev.orderId, ev.gatewayTxId);
      if (!order) {
        req.log.warn({ gateway: key, kind: ev.kind, orderId: ev.orderId, gatewayTxId: ev.gatewayTxId }, "aviso de pagamento sem pedido correspondente");
        return { ok: true };
      }
      try {
        let applied = false;
        if (ev.kind === "deposit_paid") applied = await settleDeposit(order.id, { fee: ev.fee, amount: ev.amount });
        else if (ev.kind === "deposit_expired") applied = await expireDeposit(order.id);
        else if (ev.kind === "payout_paid") applied = await settlePayout(order.id, { fee: ev.fee });
        else if (ev.kind === "payout_failed") applied = await failPayout(order.id, ev.reason);
        req.log.info({ gateway: key, kind: ev.kind, orderId: order.id, applied }, "aviso de pagamento");
        return { ok: true };
      } catch (e) {
        if (e instanceof AppError && e.code === "AMOUNT_MISMATCH") {
          req.log.error({ gateway: key, orderId: order.id, reason: e.message }, "aviso com valor diferente do pedido — NÃO creditado");
          await prisma.pixOrder.update({ where: { id: order.id }, data: { note: e.message.slice(0, 300) } });
          return { ok: true };
        }
        throw e;
      }
    });
  });
}

/** Pedido do aviso: pelo nosso id (external_id) ou pelo id do gateway. Aviso de um gateway não mexe em pedido de outro. */
async function findOrder(key: GatewayKey, orderId?: string, gatewayTxId?: string) {
  const byId = orderId ? await prisma.pixOrder.findUnique({ where: { id: orderId } }) : null;
  const o = byId ?? (gatewayTxId ? await prisma.pixOrder.findUnique({ where: { txid: `${key}:${gatewayTxId}` } }) : null);
  return o && o.gateway === key ? o : null;
}
