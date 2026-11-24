import { test } from "node:test";
import assert from "node:assert/strict";
import {
  depositBonus, rolloverTarget, splitStake, splitWin, rolloverContribution, rolloverReached, rolloverLeft, rolloverProgress,
  conversion, campaignWindow, ineligibleReason, expiresAtFrom, type CampaignRules, type EligibilityCtx,
} from "../src/services/incentive-rules.js";
import { campaignInputSchema } from "../src/schemas/incentives.js";
import { depositSchema } from "../src/schemas/wallet.js";

const base: CampaignRules = {
  trigger: "DEPOSIT", active: true, startsAt: null, endsAt: null,
  bonusPercent: 100, bonusFixed: null, maxBonus: 500, minDeposit: 20, firstDepositOnly: false, requireDeposit: false,
  rolloverTimes: 30, rolloverBase: "BONUS", maxBet: null, maxConversion: null, validDays: 7, maxPerPlayer: 1,
};
const ctx = (o: Partial<EligibilityCtx> = {}): EligibilityCtx => ({
  now: new Date("2026-11-24T12:00:00Z"), mode: "OPERATIONAL", hasActive: false, usedCount: 0, paidDeposits: 0, gamesOnSite: 5, ...o,
});

test("depositBonus: % do depósito com teto; abaixo do mínimo não tem bônus; arredonda para baixo", () => {
  assert.equal(depositBonus(base, 100), 100);
  assert.equal(depositBonus(base, 800), 500); // teto
  assert.equal(depositBonus(base, 19.99), 0); // abaixo do mínimo
  assert.equal(depositBonus({ ...base, bonusPercent: 33, minDeposit: null }, 10.01), 3.3); // 3,3033 → 3,30
  assert.equal(depositBonus({ ...base, maxBonus: null, minDeposit: null }, 0.3 * 100), 30); // sem ruído de ponto flutuante
  assert.equal(depositBonus(base, 0), 0);
});

test("rolloverTarget: N × bônus ou N × (depósito + bônus)", () => {
  assert.equal(rolloverTarget(base, 100), 3000);
  assert.equal(rolloverTarget({ ...base, rolloverBase: "DEPOSIT_BONUS" }, 100, 100), 6000);
  assert.equal(rolloverTarget({ ...base, rolloverTimes: 12.5 }, 10.1), 126.25);
});

test("splitStake: dinheiro real primeiro; bônus só nos jogos da campanha; null = saldo insuficiente", () => {
  assert.deepEqual(splitStake(10, 50, 100, true), { real: 10, bonus: 0 });
  assert.deepEqual(splitStake(10, 4, 100, true), { real: 4, bonus: 6 });
  assert.deepEqual(splitStake(10, 0, 100, true), { real: 0, bonus: 10 });
  assert.equal(splitStake(10, 4, 100, false), null); // fora da campanha o bônus não paga
  assert.equal(splitStake(10, 4, 5, true), null);
  assert.deepEqual(splitStake(0, 0, 0, false), { real: 0, bonus: 0 });
  assert.deepEqual(splitStake(0.3, 0.1, 0.2, true), { real: 0.1, bonus: 0.2 });
});

test("splitWin: prêmio na proporção da aposta (a parte do bônus volta para o bônus)", () => {
  assert.deepEqual(splitWin(20, 10, 6), { real: 8, bonus: 12 });
  assert.deepEqual(splitWin(20, 10, 0), { real: 20, bonus: 0 });
  assert.deepEqual(splitWin(20, 10, 10), { real: 0, bonus: 20 });
  assert.deepEqual(splitWin(0, 10, 10), { real: 0, bonus: 0 });
  assert.deepEqual(splitWin(10, 3, 1), { real: 6.67, bonus: 3.33 }); // centavo arredondado sem sumir: 6,67 + 3,33 = 10
});

test("rollover: aposta acima da máxima não conta; cumprido, falta e progresso", () => {
  assert.equal(rolloverContribution(5, 5), 5);
  assert.equal(rolloverContribution(5.01, 5), 0);
  assert.equal(rolloverContribution(100, null), 100);
  assert.equal(rolloverContribution(0, null), 0);
  assert.equal(rolloverReached(2999.99, 3000), false);
  assert.equal(rolloverReached(3000, 3000), true);
  assert.equal(rolloverLeft(2950.5, 3000), 49.5);
  assert.equal(rolloverLeft(3100, 3000), 0);
  assert.equal(rolloverProgress(750, 3000), 0.25);
  assert.equal(rolloverProgress(9000, 3000), 1);
});

test("conversion: bônus vira saldo real até o teto; o resto é retirado", () => {
  assert.deepEqual(conversion(250, null), { converted: 250, forfeited: 0 });
  assert.deepEqual(conversion(250, 100), { converted: 100, forfeited: 150 });
  assert.deepEqual(conversion(80, 100), { converted: 80, forfeited: 0 });
  assert.deepEqual(conversion(-3, 100), { converted: 0, forfeited: 0 });
});

test("campaignWindow e prazo do incentivo", () => {
  const now = new Date("2026-11-24T12:00:00Z");
  assert.equal(campaignWindow({ active: true, startsAt: null, endsAt: null }, now), "OPEN");
  assert.equal(campaignWindow({ active: false, startsAt: null, endsAt: null }, now), "PAUSED");
  assert.equal(campaignWindow({ active: true, startsAt: new Date("2026-12-01T00:00:00Z"), endsAt: null }, now), "SCHEDULED");
  assert.equal(campaignWindow({ active: true, startsAt: null, endsAt: now }, now), "ENDED");
  assert.equal(expiresAtFrom(now, 7).toISOString(), "2026-12-01T12:00:00.000Z");
});

test("ineligibleReason: cada regra com a mensagem certa (null = pode receber)", () => {
  assert.equal(ineligibleReason(base, ctx({ deposit: 50 })), null);
  assert.match(ineligibleReason({ ...base, active: false }, ctx())!, /não está mais disponível/);
  assert.match(ineligibleReason(base, ctx({ mode: "WITHDRAW_ONLY" }))!, /Jogo responsável/);
  assert.match(ineligibleReason(base, ctx({ hasActive: true }))!, /em andamento/);
  assert.match(ineligibleReason(base, ctx({ usedCount: 1 }))!, /já usou/);
  assert.match(ineligibleReason(base, ctx({ gamesOnSite: 0 }))!, /jogos desta campanha/);
  assert.match(ineligibleReason({ ...base, firstDepositOnly: true }, ctx({ paidDeposits: 1 }))!, /primeiro depósito/);
  assert.match(ineligibleReason(base, ctx({ deposit: 10 }))!, /Depósito mínimo para esta campanha: R\$ 20,00/);
  // motivo definitivo antes do passageiro: "só no 1º depósito" ganha de "já tem um em andamento"
  assert.match(ineligibleReason({ ...base, firstDepositOnly: true }, ctx({ paidDeposits: 1, hasActive: true }))!, /primeiro depósito/);
  const claim: CampaignRules = { ...base, trigger: "CLAIM", bonusPercent: null, bonusFixed: 10, requireDeposit: true };
  assert.match(ineligibleReason(claim, ctx())!, /já fez um depósito/);
  assert.equal(ineligibleReason(claim, ctx({ paidDeposits: 2 })), null);
});

test("campaignInputSchema: valor por tipo, rollover e datas; depósito aceita campanha", () => {
  const ok = { name: "Boas-vindas", trigger: "DEPOSIT", bonusPercent: 100, maxBonus: 500, rolloverTimes: 30, validDays: 7, gameIds: ["g1"] };
  assert.equal(campaignInputSchema.safeParse(ok).success, true);
  assert.equal(campaignInputSchema.safeParse({ ...ok, bonusPercent: null }).success, false);
  assert.equal(campaignInputSchema.safeParse({ ...ok, trigger: "CLAIM" }).success, false); // falta o valor fixo
  assert.equal(campaignInputSchema.safeParse({ ...ok, trigger: "CLAIM", bonusFixed: 10, rolloverBase: "DEPOSIT_BONUS" }).success, false);
  assert.equal(campaignInputSchema.safeParse({ ...ok, rolloverTimes: 0.5 }).success, false);
  assert.equal(campaignInputSchema.safeParse({ ...ok, gameIds: [] }).success, false);
  assert.equal(campaignInputSchema.safeParse({ ...ok, startsAt: "2026-12-02T00:00:00.000Z", endsAt: "2026-12-01T00:00:00.000Z" }).success, false);
  assert.equal(depositSchema.safeParse({ amount: 50, campaignId: "c1" }).success, true);
});
