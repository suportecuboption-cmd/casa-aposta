import { test } from "node:test";
import assert from "node:assert/strict";
import { mapPlayfiversGame, inferCategory, playfiversKey } from "../src/casino/adapters/playfivers.js";
import { ipAllowed, agentOk, agentCheck, callbackKind, pfErrorBody } from "../src/services/playfivers.js";
import { AppError } from "../src/lib/errors.js";
import { pfTxnTopSchema, pfSlotSchema, pfBalanceWebhookSchema, pfAgentUpdateSchema, pfFreeBonusGrantSchema } from "../src/schemas/playfivers.js";

/* ── mapeamento do catálogo ── */

test("mapPlayfiversGame: extrai campos do item de /games; chave = provedor + código", () => {
  const g = mapPlayfiversGame({
    name: "Book of Golden Sands", image_url: "x.webp", original: false, status: true,
    game_code: "vswaysbook", provider: { name: "PRAGMATIC" },
  });
  assert.equal(g.externalId, "pragmatic:vswaysbook");
  assert.equal(g.code, "vswaysbook");
  assert.equal(g.name, "Book of Golden Sands");
  assert.equal(g.providerName, "PRAGMATIC");
  assert.equal(g.providerRaw, "PRAGMATIC");
  assert.equal(g.providerSlug, "pragmatic");
  assert.equal(g.category, "slots");
  assert.equal(g.isLive, false);
  assert.equal(g.original, false);
  assert.equal(g.hasDemo, false);
  assert.equal(g.imageUrl, "x.webp");
  assert.equal(g.active, true);
});

test("mapPlayfiversGame: mesmo game_code em provedores diferentes vira chaves diferentes", () => {
  const clone = mapPlayfiversGame({ game_code: "126", name: "Fortune Tiger", provider: { name: "PGSOFT" } });
  const oficial = mapPlayfiversGame({ game_code: "126", name: "Fortune Tiger", provider: { name: "OFICIAL - PG SOFT" }, original: true });
  assert.notEqual(clone.externalId, oficial.externalId);
  assert.equal(oficial.externalId, "oficial-pg-soft:126");
  assert.equal(oficial.code, "126"); // código cru: é o que vai no game_launch
  assert.equal(oficial.providerRaw, "OFICIAL - PG SOFT"); // nome exato do provedor no game_launch
  assert.equal(oficial.original, true);
  assert.equal(clone.original, false); // original ausente = false
});

test("mapPlayfiversGame: status false = inativo; sem game_code fica sem chave; logo do provedor", () => {
  assert.equal(mapPlayfiversGame({ game_code: "x", name: "X", provider: { name: "JILI" }, status: false }).active, false);
  assert.equal(mapPlayfiversGame({ name: "Sem código", provider: { name: "JILI" } }).externalId, "");
  const logos = new Map([["jili", "https://img/jili.png"]]);
  assert.equal(mapPlayfiversGame({ game_code: "1", name: "A", provider: { name: "JILI" } }, logos).providerLogo, "https://img/jili.png");
});

test("inferCategory: ao vivo pelo provedor (LIVE22 é slot), crash, mesa e sportsbook", () => {
  assert.deepEqual(inferCategory("OFICIAL - EVOLUTION LIVE", "Crazy Time"), { category: "live", isLive: true });
  assert.deepEqual(inferCategory("EVOLUTION", "Lightning Roulette"), { category: "live", isLive: true });
  assert.deepEqual(inferCategory("OFICIAL - EZUGI", "Andar Bahar"), { category: "live", isLive: true });
  assert.deepEqual(inferCategory("OFICIAL - LIVE88", "Baccarat 1"), { category: "live", isLive: true });
  assert.deepEqual(inferCategory("OFICIAL - LIVE22", "Kraken Queen"), { category: "slots", isLive: false });
  assert.deepEqual(inferCategory("OFICIAL - SPRIBE", "Mini Roulette"), { category: "crash", isLive: false });
  assert.deepEqual(inferCategory("PRAGMATIC", "Spaceman"), { category: "crash", isLive: false });
  assert.deepEqual(inferCategory("OFICIAL - NETENT", "European Roulette"), { category: "mesa", isLive: false });
  assert.deepEqual(inferCategory("DIGITAIN OFICIAL", "Esporte"), { category: "sportsbook", isLive: false });
  assert.deepEqual(inferCategory("PGSOFT", "Fortune Tiger"), { category: "slots", isLive: false });
});

test("playfiversKey: normaliza o provedor e mantém o código cru", () => {
  assert.equal(playfiversKey("OFICIAL - PG SOFT", "126"), "oficial-pg-soft:126");
  assert.equal(playfiversKey("", "abc"), "playfivers:abc");
});

/* ── IP whitelist ── */

test("ipAllowed: lista vazia não bloqueia; localhost sempre passa", () => {
  assert.equal(ipAllowed("8.8.8.8", ""), true);
  assert.equal(ipAllowed("8.8.8.8", undefined), true);
  assert.equal(ipAllowed("127.0.0.1", "1.2.3.4"), true);
  assert.equal(ipAllowed("::1", "1.2.3.4"), true);
});

test("ipAllowed: com lista, só os IPs cadastrados passam", () => {
  assert.equal(ipAllowed("1.2.3.4", "1.2.3.4, 5.6.7.8"), true);
  assert.equal(ipAllowed("5.6.7.8", "1.2.3.4, 5.6.7.8"), true);
  assert.equal(ipAllowed("9.9.9.9", "1.2.3.4, 5.6.7.8"), false);
});

/* ── agent_code/agent_secret ── */

test("agentOk: sem segredo configurado RECUSA (webhook que credita saldo nunca passa sem autenticação)", () => {
  assert.equal(agentOk({ agent_code: "x", agent_secret: "y" }, undefined, undefined), false);
  assert.equal(agentOk({}, "", ""), false);
  assert.equal(agentOk({ agent_code: "A", agent_secret: "" }, "A", ""), false);
});

test("agentOk: confere o segredo e, quando configurado, o código do agente", () => {
  assert.equal(agentOk({ agent_code: "A", agent_secret: "S" }, "A", "S"), true);
  assert.equal(agentOk({ agent_code: "A", agent_secret: "x" }, "A", "S"), false);
  assert.equal(agentOk({ agent_code: "A" }, "A", "S"), false);
  assert.equal(agentOk({ agent_code: "B", agent_secret: "S" }, "A", "S"), false); // código errado
  assert.equal(agentOk({ agent_code: "QUALQUER", agent_secret: "S" }, "", "S"), true); // código não configurado: só o segredo
  assert.equal(agentOk({ agent_code: "A", agent_secret: 123 as unknown as string }, "A", "S"), false); // tipo errado
});

test("agentCheck: diz por que recusou (vai para o log do operador)", () => {
  assert.deepEqual(agentCheck({ agent_code: "A", agent_secret: "S" }, "A", ""), { ok: false, reason: "no_secret_configured" });
  assert.deepEqual(agentCheck({ agent_code: "A", agent_secret: "x" }, "A", "S"), { ok: false, reason: "secret_mismatch" });
  assert.deepEqual(agentCheck({ agent_code: "B", agent_secret: "S" }, "A", "S"), { ok: false, reason: "agent_code_mismatch" });
  assert.deepEqual(agentCheck({ agent_code: "A", agent_secret: "S" }, "A", "S"), { ok: true });
});

/* ── callback único (a PlayFivers manda tudo para a Callback URL do agente) ── */

test("callbackKind: o campo type decide o handler (BALANCE → saldo; WinBet/Refund → transação)", () => {
  assert.equal(callbackKind({ type: "BALANCE", user_code: "u1" }), "balance");
  assert.equal(callbackKind({ type: "balance" }), "balance");
  assert.equal(callbackKind({ type: "WinBet" }), "txn");
  assert.equal(callbackKind({ type: " refund " }), "txn");
  assert.equal(callbackKind({ type: "Deposit" }), null);
  assert.equal(callbackKind({}), null);
  assert.equal(callbackKind(undefined), null);
  assert.equal(callbackKind("BALANCE"), null);
});

test("pfErrorBody: erros no formato da doc (INVALID_USER, INSUFFICIENT_USER_FUNDS, ERROR_INTERNAL)", () => {
  assert.deepEqual(pfErrorBody(new AppError("Usuário não encontrado", 404, "USER_NOT_FOUND")), { status: 404, msg: "INVALID_USER" });
  assert.deepEqual(pfErrorBody(new AppError("Saldo insuficiente", 400, "INSUFFICIENT_FUNDS")), { status: 400, msg: "INSUFFICIENT_USER_FUNDS" });
  assert.deepEqual(pfErrorBody(new AppError("Jogador bloqueado", 403, "PLAYER_BLOCKED")), { status: 403, msg: "PLAYER_BLOCKED" });
  assert.deepEqual(pfErrorBody(new Error("boom")), { status: 500, msg: "ERROR_INTERNAL" });
});

/* ── schemas dos webhooks ── */

test("pfSlotSchema: exige txn_id e aceita bet/win numéricos", () => {
  assert.equal(pfSlotSchema.safeParse({ txn_id: "T1", bet: 50, win: 100, round_id: "R1", game_code: "126" }).success, true);
  assert.equal(pfSlotSchema.safeParse({ bet: 10 }).success, false);
});

test("pfTxnTopSchema: só aceita WinBet/Refund e exige user_code", () => {
  assert.equal(pfTxnTopSchema.safeParse({ type: "WinBet", user_code: "u1" }).success, true);
  assert.equal(pfTxnTopSchema.safeParse({ type: "Refund", user_code: "u1" }).success, true);
  assert.equal(pfTxnTopSchema.safeParse({ type: "Deposit", user_code: "u1" }).success, false);
  assert.equal(pfTxnTopSchema.safeParse({ type: "WinBet" }).success, false);
});

test("pfBalanceWebhookSchema: exige user_code", () => {
  assert.equal(pfBalanceWebhookSchema.safeParse({ type: "BALANCE", user_code: "u1" }).success, true);
  assert.equal(pfBalanceWebhookSchema.safeParse({ type: "BALANCE" }).success, false);
});

/* ── schemas do admin (agente / rodadas grátis) ── */

test("pfAgentUpdateSchema: aceita config válida e recusa RTP fora de 0–100", () => {
  assert.equal(pfAgentUpdateSchema.safeParse({ rtp: 96, limit_enable: true, limit_amount: 20000, limit_hours: 24, bonus_enable: false }).success, true);
  assert.equal(pfAgentUpdateSchema.safeParse({ rtp: 120, limit_enable: true, limit_amount: 1, limit_hours: 1, bonus_enable: false }).success, false);
  assert.equal(pfAgentUpdateSchema.safeParse({ rtp: 96, limit_enable: true, limit_amount: 1, limit_hours: 0, bonus_enable: false }).success, false);
});

test("pfFreeBonusGrantSchema: rounds entre 1 e 23 e exige jogador/jogo", () => {
  assert.equal(pfFreeBonusGrantSchema.safeParse({ user_code: "u1", game_code: "126", rounds: 10 }).success, true);
  assert.equal(pfFreeBonusGrantSchema.safeParse({ user_code: "u1", game_code: "126", rounds: 24 }).success, false);
  assert.equal(pfFreeBonusGrantSchema.safeParse({ user_code: "u1", game_code: "126", rounds: 0 }).success, false);
  assert.equal(pfFreeBonusGrantSchema.safeParse({ user_code: "", game_code: "126", rounds: 5 }).success, false);
});
