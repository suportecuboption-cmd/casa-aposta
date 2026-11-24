import { createHash } from "node:crypto";
import { gatewayCreds } from "./config.js";
import { GatewayError, gatewayErrorFrom, gwFetch, normIp, num, pixKeyFor, round2, str } from "./http.js";
import type { PixGateway, Verify, WebhookEvent } from "./types.js";

/**
 * BSPay (https://doc.bspay.co). OAuth client_credentials → Bearer de 1 h, guardado em memória (o
 * /oauth/token aceita só 30 pedidos/min). Valores em REAIS. Os avisos (webhooks) não são assinados:
 * a própria doc manda conferir o IP de origem.
 */

const BASE = "https://api.bspay.co";
export const BSPAY_WEBHOOK_IPS = ["185.193.127.186", "2a0a:3840:1337:127::b9c1:7fba:1337"];

let tokenCache: { fp: string; token: string; exp: number } | null = null;

async function token(): Promise<string> {
  const { clientId = "", clientSecret = "" } = gatewayCreds("bspay");
  if (!clientId || !clientSecret) throw new GatewayError("BSPay sem credenciais", 409, "NOT_CONFIGURED");
  const fp = createHash("sha256").update(`${clientId}:${clientSecret}`).digest("hex");
  if (tokenCache && tokenCache.fp === fp && Date.now() < tokenCache.exp) return tokenCache.token;
  const r = await gwFetch(`${BASE}/v2/oauth/token`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`, "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "client_credentials" }),
  });
  const t = str(r.json?.access_token) ?? str(r.json?.data?.access_token);
  if (!r.ok || !t) throw gatewayErrorFrom(r.json, "Falha ao autenticar na BSPay");
  const ttl = num(r.json?.expires_in ?? r.json?.data?.expires_in) ?? 3600;
  tokenCache = { fp, token: t, exp: Date.now() + Math.max(60, ttl - 120) * 1000 };
  return t;
}

async function call(method: "GET" | "POST", path: string, body?: unknown) {
  const t = await token();
  const r = await gwFetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${t}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (r.status === 401) tokenCache = null; // expirou ou foi revogado: o próximo pedido gera outro
  if (!r.ok || r.json?.success === false) throw gatewayErrorFrom(r.json, "A BSPay recusou o pedido");
  return r.json;
}

/** Pura: IP autorizado a mandar aviso (lista configurada ou, se vazia, a da documentação). */
export function bspayIpOk(ip: string, configured?: string): boolean {
  const list = (configured ?? "").split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
  return (list.length ? list : BSPAY_WEBHOOK_IPS).map(normIp).includes(normIp(ip));
}

/** Pura: aviso da BSPay ({ event, data }) → o que fazer com o pedido. */
export function parseBspayWebhook(body: unknown): WebhookEvent {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, any>;
  const d = (b.data && typeof b.data === "object" ? b.data : {}) as Record<string, any>;
  const ev = String(b.event ?? "");
  const base = { orderId: str(d.external_id), gatewayTxId: str(d.transaction_id) ?? str(b.transaction_id) };
  switch (ev) {
    case "cashin.confirmed":
      return { kind: "deposit_paid", ...base, amount: num(d.amount), fee: num(d.fee) };
    case "cashin.expired":
      return { kind: "deposit_expired", ...base };
    case "cashout.confirmed":
      return { kind: "payout_paid", ...base, fee: num(d.fee) };
    case "cashout.failed":
      return { kind: "payout_failed", ...base, reason: str(d.error_message) ?? str(d.error_code) ?? "Saque recusado pela BSPay" };
    case "cashout.refunded":
      return { kind: "payout_failed", ...base, reason: "Saque estornado pela BSPay" };
    default:
      return { kind: "ignored", event: ev || "(sem evento)" };
  }
}

export const bspay: PixGateway = {
  key: "bspay",
  name: "BSPay",
  site: "https://app.bspay.co",
  webhookHelp:
    "A URL abaixo vai junto em cada cobrança e saque (postback_url). Cadastre-a também como postback padrão da credencial no dashboard da BSPay. A BSPay não assina os avisos — aceitamos só os IPs dela.",

  async balance() {
    const j = await call("GET", "/v2/account/balance");
    const list: any[] = Array.isArray(j?.data?.balances) ? j.data.balances : [];
    const brl = list.find((x) => String(x?.currency ?? "").toUpperCase() === "BRL");
    return num(brl?.available) ?? num(j?.data?.wallet_total_brl) ?? null;
  },

  async createDeposit(i) {
    const j = await call("POST", "/v2/transactions/cashin", {
      amount: round2(i.amount),
      currency: "BRL",
      external_id: i.orderId,
      payer: { name: i.payer.name, ...(i.payer.document ? { document: i.payer.document } : {}), ...(i.payer.email ? { email: i.payer.email } : {}) },
      ...(i.postbackUrl ? { postback_url: i.postbackUrl } : {}),
    });
    const d = j?.data ?? {};
    const id = str(d.transaction_id);
    const code = str(d.payment_info?.qrcode);
    if (!id || !code) throw new GatewayError("A BSPay não devolveu o PIX", 502);
    return { gatewayTxId: id, pixCopy: code, expiresAt: str(d.payment_info?.expires_at), fee: num(d.fee) };
  },

  async createPayout(i) {
    const k = pixKeyFor(i.pixKeyType, i.pixKey);
    const j = await call("POST", "/v2/transactions/cashout", {
      external_id: i.orderId,
      amount: round2(i.amount),
      currency: "BRL",
      key: k.key,
      key_type: k.type,
      ...(i.name ? { name: i.name } : {}),
      description: "Saque",
      ...(i.postbackUrl ? { postback_url: i.postbackUrl } : {}),
    });
    const id = str(j?.data?.transaction_id);
    if (!id) throw new GatewayError("A BSPay não confirmou o saque", 502);
    return { gatewayTxId: id };
  },

  verifyWebhook(r): Verify {
    return bspayIpOk(r.ip, gatewayCreds("bspay").webhookIps) ? { ok: true } : { ok: false, reason: `IP ${r.ip} fora da lista da BSPay` };
  },

  parseWebhook: parseBspayWebhook,
};
