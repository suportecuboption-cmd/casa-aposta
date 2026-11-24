import { createHmac, timingSafeEqual } from "node:crypto";
import { gatewayCreds } from "./config.js";
import { GatewayError, gatewayErrorFrom, gwFetch, num, pixKeyFor, str, toCents } from "./http.js";
import type { PixGateway, Verify, WebhookEvent } from "./types.js";

/**
 * SwytchPay (https://go.swytchpay.app/docs). Autentica com x-api-key + x-api-secret em toda chamada
 * (sem token). Valores em CENTAVOS. Avisos assinados: X-Swytch-Signature = "sha256=" + HMAC-SHA256
 * hex de "timestamp.corpo" com o segredo do webhook (cadastrado no painel deles).
 */

const BASE = "https://api.go.swytchpay.app/v1";

async function call(method: "GET" | "POST", path: string, body?: unknown) {
  const { apiKey = "", apiSecret = "" } = gatewayCreds("swytchpay");
  if (!apiKey || !apiSecret) throw new GatewayError("SwytchPay sem credenciais", 409, "NOT_CONFIGURED");
  const r = await gwFetch(`${BASE}${path}`, {
    method,
    headers: { "x-api-key": apiKey, "x-api-secret": apiSecret, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw gatewayErrorFrom(r.json, "A SwytchPay recusou o pedido");
  return r.json;
}

/** Pura: confere a assinatura do aviso, com janela de 5 min contra reenvio malicioso. */
export function swytchSignatureOk(
  secret: string,
  timestamp: string | undefined,
  rawBody: string,
  signature: string | undefined,
  nowSec = Math.floor(Date.now() / 1000),
): Verify {
  if (!secret) return { ok: false, reason: "segredo do webhook não configurado" };
  if (!timestamp || !signature) return { ok: false, reason: "aviso sem assinatura" };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > 300) return { ok: false, reason: "timestamp fora da janela de 5 minutos" };
  const expected = Buffer.from("sha256=" + createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex"));
  const got = Buffer.from(signature.trim());
  return got.length === expected.length && timingSafeEqual(got, expected) ? { ok: true } : { ok: false, reason: "assinatura não confere" };
}

const cents = (v: unknown) => {
  const n = num(v);
  return n === undefined ? undefined : n / 100;
};

/** Pura: aviso da SwytchPay ({ event, data }) → o que fazer com o pedido. */
export function parseSwytchWebhook(body: unknown): WebhookEvent {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, any>;
  const d = (b.data && typeof b.data === "object" ? b.data : {}) as Record<string, any>;
  const ev = String(b.event ?? "");
  const base = { orderId: str(d.external_id), gatewayTxId: str(d.id) };
  switch (ev) {
    case "deposit.paid":
      return { kind: "deposit_paid", ...base, amount: cents(d.amount_cents) ?? cents(d.amount_minor), fee: cents(d.fee_cents) };
    case "deposit.expired":
    case "deposit.canceled":
      return { kind: "deposit_expired", ...base };
    case "payout.paid":
      return { kind: "payout_paid", ...base, fee: cents(d.fee_cents) };
    case "payout.failed":
    case "payout.returned":
    case "payout.canceled":
      return {
        kind: "payout_failed",
        ...base,
        reason: str(d.failure_message) ?? str(d.failure_reason) ?? str(d.return_reason) ?? `Saque não concluído (${ev})`,
      };
    default:
      return { kind: "ignored", event: ev || "(sem evento)" };
  }
}

const header = (h: Record<string, string | string[] | undefined>, k: string) => {
  const v = h[k];
  return Array.isArray(v) ? v[0] : v;
};

export const swytchpay: PixGateway = {
  key: "swytchpay",
  name: "SwytchPay",
  site: "https://go.swytchpay.app",
  webhookHelp:
    "No painel da SwytchPay, em Desenvolvedores → Webhooks, crie um webhook com a URL abaixo (formato padrão), marque os eventos de depósito e de saque e cole aqui o segredo que aparece na criação.",

  async balance() {
    const j = await call("GET", "/balance");
    const n = num(j?.available_minor);
    return n === undefined ? null : n / 100;
  },

  async createDeposit(i) {
    const j = await call("POST", "/deposits", {
      external_id: i.orderId,
      amount_cents: toCents(i.amount),
      currency: "BRL",
      method: "PIX",
      payer: { name: i.payer.name, ...(i.payer.document ? { document: i.payer.document } : {}), ...(i.payer.email ? { email: i.payer.email } : {}) },
    });
    const id = str(j?.id);
    const emv = str(j?.pix?.emv) ?? str(j?.charge?.emv);
    if (!id || !emv) throw new GatewayError("A SwytchPay não devolveu o PIX", 502);
    const exp = num(j?.expires_at);
    return { gatewayTxId: id, pixCopy: emv, expiresAt: exp ? new Date(exp * 1000).toISOString() : undefined, fee: cents(j?.fee_cents) };
  },

  async createPayout(i) {
    const k = pixKeyFor(i.pixKeyType, i.pixKey);
    const j = await call("POST", "/payouts", {
      external_id: i.orderId,
      amount: toCents(i.amount),
      currency: "BRL",
      destination: { type: "pix", pix_key: k.key, pix_key_type: k.type },
    });
    const status = String(j?.status ?? "").toUpperCase();
    if (status === "FAILED" || status === "REJECTED") {
      throw new GatewayError(str(j?.failure_message) ?? str(j?.failure_reason) ?? "A SwytchPay recusou o saque", 502);
    }
    const id = str(j?.id);
    if (!id) throw new GatewayError("A SwytchPay não confirmou o saque", 502);
    return { gatewayTxId: id };
  },

  verifyWebhook(r) {
    return swytchSignatureOk(gatewayCreds("swytchpay").webhookSecret ?? "", header(r.headers, "x-swytch-timestamp"), r.rawBody, header(r.headers, "x-swytch-signature"));
  },

  parseWebhook: parseSwytchWebhook,
};
