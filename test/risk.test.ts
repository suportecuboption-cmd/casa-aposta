import { test } from "node:test";
import assert from "node:assert/strict";
import { riskScore, RISK_WEIGHTS, type RiskSignals } from "../src/services/risk.js";

const clean: RiskSignals = {
  deposits30: 0, depositAmount30: 0, failedPix30: 0, kycVerified: true, accountAgeDays: 365, hasCpf: true,
  distinctIps30: 1, sessions30: 5, turnover30: 0, payout30: 0, sharedPhoneUsers: 0, sharedIpUsers: 0,
};
const comp = (r: ReturnType<typeof riskScore>, key: string) => r.components.find((c) => c.key === key)!;

/* ── exemplo do Axio: só Compliance = 66,67 → score 10 ── */
test("só Compliance (2 de 3 fatores) dá 66,67 e score 10, como no print do Axio", () => {
  // KYC não verificado + sem CPF = 2 fatores; conta antiga (não conta o 3º fator)
  const r = riskScore({ ...clean, kycVerified: false, hasCpf: false, accountAgeDays: 365 });
  assert.equal(comp(r, "compliance").value, 66.67);
  assert.equal(r.score, 10);
  assert.equal(r.level, "Baixo");
});

test("jogador limpo tem score 0 e nível Baixo", () => {
  const r = riskScore(clean);
  assert.equal(r.score, 0);
  assert.equal(r.level, "Baixo");
});

/* ── componentes isolados ── */
test("falhas de pagamento somam 25 por PIX recusado e travam em 100", () => {
  assert.equal(comp(riskScore({ ...clean, failedPix30: 2 }), "paymentFailures").value, 50);
  assert.equal(comp(riskScore({ ...clean, failedPix30: 10 }), "paymentFailures").value, 100); // cap
});
test("pagamentos pontuam por muitos depósitos e por volume alto", () => {
  assert.equal(comp(riskScore({ ...clean, deposits30: 15 }), "payments").value, 50);
  assert.equal(comp(riskScore({ ...clean, deposits30: 15, depositAmount30: 20000 }), "payments").value, 100);
});
test("produto pontua com RTP do jogador acima de 120% e volume relevante", () => {
  assert.equal(comp(riskScore({ ...clean, turnover30: 1000, payout30: 1300 }), "product").value, 60);
});
test("multi-conta pontua por celular e IP compartilhados", () => {
  const r = riskScore({ ...clean, sharedPhoneUsers: 1, sharedIpUsers: 2 });
  assert.equal(comp(r, "multiAccount").value, 100); // 50 + 50
});

/* ── níveis ── */
test("score alto classifica como Alto", () => {
  const r = riskScore({
    deposits30: 20, depositAmount30: 50000, failedPix30: 4, kycVerified: false, accountAgeDays: 1, hasCpf: false,
    distinctIps30: 8, sessions30: 400, turnover30: 1000, payout30: 2000, sharedPhoneUsers: 2, sharedIpUsers: 2,
  });
  assert.ok(r.score >= 60, `esperava Alto, veio ${r.score}`);
  assert.equal(r.level, "Alto");
});

test("os pesos somam 1", () => {
  const total = Object.values(RISK_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
});
