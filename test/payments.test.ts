import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  mergeGatewayCreds,
  gatewayConfigured,
  parsePayments,
  publicPaymentsView,
  normalizePublicBase,
  type PaymentsConfig,
} from "../src/payments/config.js";
import { swytchSignatureOk, parseSwytchWebhook } from "../src/payments/swytchpay.js";
import { parseBspayWebhook, bspayIpOk } from "../src/payments/bspay.js";
import { pixKeyFor, clientIp, gatewayErrorFrom } from "../src/payments/http.js";

const cfg = (over: Partial<PaymentsConfig> = {}): PaymentsConfig => ({
  active: null,
  publicBaseUrl: "",
  gateways: { swytchpay: {}, bspay: {} },
  updatedAt: null,
  updatedBy: null,
  ...over,
});

/* ── configuração ── */

test("mergeGatewayCreds: segredo em branco mantém; campo comum substitui; clear apaga tudo", () => {
  const cur = { apiKey: "ak_live_1", apiSecret: "sk_live_segredo", webhookSecret: "whsec_1" };
  assert.deepEqual(mergeGatewayCreds("swytchpay", cur, { apiKey: " ak_live_2 ", apiSecret: "  ", webhookSecret: "" }), {
    apiKey: "ak_live_2",
    apiSecret: "sk_live_segredo",
    webhookSecret: "whsec_1",
  });
  assert.equal(mergeGatewayCreds("swytchpay", cur, { apiSecret: "sk_novo" }).apiSecret, "sk_novo");
  assert.deepEqual(mergeGatewayCreds("swytchpay", cur, {}, true), {});
  assert.equal("hack" in mergeGatewayCreds("bspay", {}, { hack: "x", clientId: "id" }), false); // campo desconhecido é ignorado
});

test("gatewayConfigured: exige só os campos obrigatórios", () => {
  assert.equal(gatewayConfigured("bspay", { clientId: "id", clientSecret: "s" }), true); // IPs dos avisos são opcionais
  assert.equal(gatewayConfigured("bspay", { clientId: "id" }), false);
  assert.equal(gatewayConfigured("swytchpay", { apiKey: "a", apiSecret: "b" }), false); // sem segredo do webhook não confirma pagamento
  assert.equal(gatewayConfigured("swytchpay", { apiKey: "a", apiSecret: "b", webhookSecret: "c" }), true);
});

test("parsePayments: JSON vazio/quebrado volta ao padrão; gateway desconhecido vira modo manual", () => {
  assert.equal(parsePayments(null).active, null);
  assert.equal(parsePayments("{oops").publicBaseUrl, "");
  const p = parsePayments(JSON.stringify({ active: "paypal", gateways: { bspay: { clientId: "x", lixo: "y" } } }));
  assert.equal(p.active, null);
  assert.deepEqual(p.gateways.bspay, { clientId: "x" });
  assert.equal(parsePayments(JSON.stringify({ active: "bspay" })).active, "bspay");
});

test("publicPaymentsView: nunca expõe segredos (só se estão salvos e o final)", () => {
  const v = publicPaymentsView(
    cfg({
      active: "swytchpay",
      gateways: {
        swytchpay: { apiKey: "ak_live_abc", apiSecret: "sk_live_SEGREDO1234", webhookSecret: "whsec_SEGREDO9876" },
        bspay: { clientSecret: "bs_SEGREDO5555" },
      },
    }),
  );
  assert.ok(!JSON.stringify(v).includes("SEGREDO"));
  const sw = v.gateways.find((g) => g.key === "swytchpay")!;
  assert.equal(sw.configured, true);
  const sec = sw.fields.find((f) => f.key === "apiSecret") as unknown as { set: boolean; hint: string };
  assert.deepEqual([sec.set, sec.hint], [true, "••••1234"]);
  const key = sw.fields.find((f) => f.key === "apiKey") as unknown as { value: string };
  assert.equal(key.value, "ak_live_abc"); // a API key não é segredo (o segredo é o sk_)
});

test("normalizePublicBase: tira espaços e barras do fim", () => {
  assert.equal(normalizePublicBase(" https://x.trycloudflare.com// "), "https://x.trycloudflare.com");
  assert.equal(normalizePublicBase(""), "");
});

/* ── SwytchPay ── */

const sign = (secret: string, ts: string, body: string) => "sha256=" + createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");

test("swytchSignatureOk: aceita a assinatura certa; recusa corpo alterado, segredo errado, aviso velho e sem segredo", () => {
  const body = JSON.stringify({ event: "deposit.paid", data: { external_id: "o1" } });
  const now = 1_800_000_000;
  const ts = String(now);
  assert.deepEqual(swytchSignatureOk("whsec", ts, body, sign("whsec", ts, body), now), { ok: true });
  assert.equal(swytchSignatureOk("whsec", ts, body + " ", sign("whsec", ts, body), now).ok, false);
  assert.equal(swytchSignatureOk("outro", ts, body, sign("whsec", ts, body), now).ok, false);
  const old = String(now - 301);
  assert.equal(swytchSignatureOk("whsec", old, body, sign("whsec", old, body), now).ok, false);
  assert.equal(swytchSignatureOk("whsec", ts, body, undefined, now).ok, false);
  assert.equal(swytchSignatureOk("", ts, body, sign("", ts, body), now).ok, false);
});

test("parseSwytchWebhook: depósito pago em centavos → reais; saque devolvido vira falha", () => {
  assert.deepEqual(parseSwytchWebhook({ event: "deposit.paid", data: { id: "dep_1", external_id: "o1", amount_cents: 15000, fee_cents: 150 } }), {
    kind: "deposit_paid",
    orderId: "o1",
    gatewayTxId: "dep_1",
    amount: 150,
    fee: 1.5,
  });
  assert.equal(parseSwytchWebhook({ event: "deposit.expired", data: { external_id: "o1" } }).kind, "deposit_expired");
  assert.deepEqual(parseSwytchWebhook({ event: "payout.returned", data: { id: "pay_1", external_id: "o2", return_reason: "conta encerrada" } }), {
    kind: "payout_failed",
    orderId: "o2",
    gatewayTxId: "pay_1",
    reason: "conta encerrada",
  });
  assert.deepEqual(parseSwytchWebhook({ event: "med.opened" }), { kind: "ignored", event: "med.opened" });
});

/* ── BSPay ── */

test("parseBspayWebhook: cashin.confirmed em reais (texto); cashout.failed traz o motivo", () => {
  assert.deepEqual(
    parseBspayWebhook({ event: "cashin.confirmed", transaction_id: "t1", data: { transaction_id: "t1", external_id: "o1", amount: "100.00", fee: "1.50" } }),
    { kind: "deposit_paid", orderId: "o1", gatewayTxId: "t1", amount: 100, fee: 1.5 },
  );
  assert.deepEqual(
    parseBspayWebhook({ event: "cashout.failed", data: { transaction_id: "t2", external_id: "o2", error_code: "PIX_KEY_NOT_FOUND", error_message: "Chave não encontrada" } }),
    { kind: "payout_failed", orderId: "o2", gatewayTxId: "t2", reason: "Chave não encontrada" },
  );
  assert.equal(parseBspayWebhook({ event: "cashout.confirmed", data: { external_id: "o3" } }).kind, "payout_paid");
  assert.equal(parseBspayWebhook({ event: "chargeback.opened", data: {} }).kind, "ignored");
  assert.equal(parseBspayWebhook(null).kind, "ignored");
});

test("bspayIpOk: só os IPs da BSPay (ou a lista configurada)", () => {
  assert.equal(bspayIpOk("185.193.127.186"), true);
  assert.equal(bspayIpOk("::ffff:185.193.127.186"), true);
  assert.equal(bspayIpOk("2A0A:3840:1337:127::B9C1:7FBA:1337"), true);
  assert.equal(bspayIpOk("8.8.8.8"), false);
  assert.equal(bspayIpOk("8.8.8.8", "8.8.8.8, 1.1.1.1"), true);
  assert.equal(bspayIpOk("185.193.127.186", "1.1.1.1"), false); // lista própria substitui a padrão
});

/* ── utilidades ── */

test("pixKeyFor: chaves do cadastro no formato dos gateways", () => {
  assert.deepEqual(pixKeyFor("CPF", "123.456.789-09"), { key: "12345678909", type: "cpf" });
  assert.deepEqual(pixKeyFor("CELULAR", "(11) 99999-8888"), { key: "+5511999998888", type: "phone" });
  assert.deepEqual(pixKeyFor("CELULAR", "+55 11 99999-8888"), { key: "+5511999998888", type: "phone" });
  assert.deepEqual(pixKeyFor("CELULAR", "(55) 99999-8888"), { key: "+5555999998888", type: "phone" }); // DDD 55
  assert.deepEqual(pixKeyFor("EMAIL", " Ana@Exemplo.com "), { key: "ana@exemplo.com", type: "email" });
  assert.deepEqual(pixKeyFor("ALEATORIA", " 123e4567-e89b-12d3-a456-426614174000 "), { key: "123e4567-e89b-12d3-a456-426614174000", type: "random" });
});

test("clientIp: atrás do túnel usa o cabeçalho; conexão direta usa o IP dela (cabeçalho forjado não vale)", () => {
  assert.equal(clientIp("127.0.0.1", { "cf-connecting-ip": "185.193.127.186" }), "185.193.127.186");
  assert.equal(clientIp("::1", { "x-forwarded-for": "185.193.127.186, 10.0.0.1" }), "185.193.127.186");
  assert.equal(clientIp("::ffff:127.0.0.1", {}), "127.0.0.1");
  assert.equal(clientIp("203.0.113.9", { "cf-connecting-ip": "185.193.127.186" }), "203.0.113.9");
});

test("gatewayErrorFrom: usa a mensagem e o código do gateway", () => {
  const e = gatewayErrorFrom({ success: false, error: { code: "INSUFFICIENT_FUNDS", message: "Saldo insuficiente" } }, "falhou");
  assert.equal(e.message, "Saldo insuficiente (INSUFFICIENT_FUNDS)");
  assert.equal(e.code, "INSUFFICIENT_FUNDS");
  assert.equal(gatewayErrorFrom(null, "falhou").message, "falhou");
});
