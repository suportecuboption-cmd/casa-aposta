import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mergePlayfivers,
  normalizeIps,
  invalidIps,
  secretHint,
  parseInstall,
  publicInstallView,
  DEFAULT_PF_BASE,
  type PlayfiversInstall,
} from "../src/services/install-config.js";

const cur: PlayfiversInstall = { baseUrl: DEFAULT_PF_BASE, agentCode: "AG1", agentToken: "tok-aaaa1111", secretKey: "sec-bbbb2222", ipAllowlist: "" };

test("mergePlayfivers: token/segredo em branco mantêm os atuais (o painel não os mostra)", () => {
  const m = mergePlayfivers(cur, { agentToken: "", secretKey: "   ", agentCode: "AG1" });
  assert.equal(m.agentToken, "tok-aaaa1111");
  assert.equal(m.secretKey, "sec-bbbb2222");
});

test("mergePlayfivers: valores novos substituem; URL perde a barra final e volta ao padrão se vazia", () => {
  const m = mergePlayfivers(cur, { agentToken: " novo-token ", secretKey: "novo-seg", baseUrl: "https://api.exemplo.com//" });
  assert.equal(m.agentToken, "novo-token");
  assert.equal(m.secretKey, "novo-seg");
  assert.equal(m.baseUrl, "https://api.exemplo.com");
  assert.equal(mergePlayfivers({ ...cur, baseUrl: "" }, { baseUrl: "" }).baseUrl, DEFAULT_PF_BASE);
});

test("mergePlayfivers: código do agente pode ser apagado; clearCredentials limpa código, token e segredo", () => {
  assert.equal(mergePlayfivers(cur, { agentCode: "" }).agentCode, "");
  const c = mergePlayfivers(cur, { clearCredentials: true });
  assert.deepEqual([c.agentCode, c.agentToken, c.secretKey], ["", "", ""]);
  assert.equal(c.baseUrl, DEFAULT_PF_BASE);
});

test("IPs: aceita vírgula, ponto e vírgula, espaço e quebra de linha; aponta o que não é IP", () => {
  assert.equal(normalizeIps("1.2.3.4; 5.6.7.8\n1.2.3.4  2001:db8::1"), "1.2.3.4, 5.6.7.8, 2001:db8::1");
  assert.deepEqual(invalidIps("1.2.3.4, exemplo.com, 10.0.0.1"), ["exemplo.com"]);
  assert.deepEqual(invalidIps(""), []);
});

test("secretHint e visão pública: nunca expõem token nem segredo", () => {
  assert.equal(secretHint("tok-aaaa1111"), "••••1111");
  assert.equal(secretHint(""), "");
  const v = publicInstallView({ playfivers: cur, updatedAt: null, updatedBy: null });
  const json = JSON.stringify(v);
  assert.ok(!json.includes("tok-aaaa1111") && !json.includes("sec-bbbb2222"));
  assert.equal(v.playfivers.configured, true);
  assert.equal(v.playfivers.agentTokenHint, "••••1111");
});

test("parseInstall: JSON vazio ou quebrado volta ao padrão; campos faltando são completados", () => {
  assert.equal(parseInstall(null).playfivers.baseUrl, DEFAULT_PF_BASE);
  assert.equal(parseInstall("{oops").playfivers.agentToken, "");
  const p = parseInstall(JSON.stringify({ playfivers: { agentToken: "x" } }));
  assert.equal(p.playfivers.agentToken, "x");
  assert.equal(p.playfivers.baseUrl, DEFAULT_PF_BASE);
});
