import { test } from "node:test";
import assert from "node:assert/strict";
import {
  restrictionActive,
  accessMode,
  periodStart,
  fitsLimit,
  effectiveWithdrawLimits,
  checkWithdraw,
  DEFAULT_HOUSE_WITHDRAW,
  type RestrictionLike,
  type WithdrawLimits,
} from "../src/services/protection.js";

const NOW = new Date("2026-11-24T15:00:00Z"); // terça, 12:00 em São Paulo
const r = (over: Partial<RestrictionLike> = {}): RestrictionLike => ({
  kind: "SUSPENSION", scope: "GAMING", startsAt: new Date("2026-11-20T00:00:00Z"), endsAt: null, revokedAt: null, ...over,
});

/* ── restrictionActive ── */
test("restrição vale agora quando não foi retirada, já começou e não expirou", () => {
  assert.equal(restrictionActive(r(), NOW), true);
  assert.equal(restrictionActive(r({ endsAt: new Date("2026-12-01T00:00:00Z") }), NOW), true);
});
test("restrição não vale se retirada, futura ou expirada", () => {
  assert.equal(restrictionActive(r({ revokedAt: NOW }), NOW), false);
  assert.equal(restrictionActive(r({ startsAt: new Date("2026-12-01T00:00:00Z") }), NOW), false);
  assert.equal(restrictionActive(r({ endsAt: new Date("2026-11-21T00:00:00Z") }), NOW), false);
});

/* ── accessMode ── */
test("conta inativa fica BLOCKED mesmo sem restrição", () => {
  assert.equal(accessMode(false, [], NOW), "BLOCKED");
});
test("restrição TOTAL ativa bloqueia tudo; GAMING deixa só sacar; sem restrição é operacional", () => {
  assert.equal(accessMode(true, [r({ scope: "TOTAL" })], NOW), "BLOCKED");
  assert.equal(accessMode(true, [r({ scope: "GAMING" })], NOW), "WITHDRAW_ONLY");
  assert.equal(accessMode(true, [], NOW), "OPERATIONAL");
});
test("restrição retirada/expirada não muda o modo de acesso", () => {
  assert.equal(accessMode(true, [r({ scope: "TOTAL", revokedAt: NOW })], NOW), "OPERATIONAL");
  assert.equal(accessMode(true, [r({ scope: "GAMING", endsAt: new Date("2026-11-21T00:00:00Z") })], NOW), "OPERATIONAL");
});

/* ── periodStart (fuso São Paulo) ── */
test("início do período: dia, semana (segunda) e mês, à meia-noite de São Paulo", () => {
  assert.equal(periodStart("DAY", NOW).toISOString(), "2026-11-24T03:00:00.000Z");
  assert.equal(periodStart("WEEK", NOW).toISOString(), "2026-11-23T03:00:00.000Z"); // segunda 23/11
  assert.equal(periodStart("MONTH", NOW).toISOString(), "2026-11-01T03:00:00.000Z");
});

/* ── fitsLimit ── */
test("fitsLimit respeita o teto com folga de centavos", () => {
  assert.equal(fitsLimit(100, 60, 40), true);
  assert.equal(fitsLimit(100, 60, 40.01), false);
  assert.equal(fitsLimit(100, 100, 0), true);
});

/* ── effectiveWithdrawLimits ── */
test("limite individual preenchido vence a casa; vazio herda", () => {
  const house: WithdrawLimits = { maxPerWithdrawal: 10000, dailyAmount: 10000, dailyCount: null, minIntervalMin: null };
  const e1 = effectiveWithdrawLimits(house, null);
  assert.deepEqual(e1.limits, house);
  assert.equal(e1.source.maxPerWithdrawal, "house");

  const e2 = effectiveWithdrawLimits(house, { maxPerWithdrawal: 500, dailyCount: 3 });
  assert.equal(e2.limits.maxPerWithdrawal, 500);
  assert.equal(e2.limits.dailyAmount, 10000); // herdado
  assert.equal(e2.limits.dailyCount, 3);
  assert.equal(e2.source.maxPerWithdrawal, "individual");
  assert.equal(e2.source.dailyAmount, "house");
});

/* ── checkWithdraw ── */
const base = { amount: 100, todaySum: 0, todayCount: 0, lastAt: null as Date | null, now: NOW };
test("sem limites configurados, o saque passa", () => {
  assert.equal(checkWithdraw({ maxPerWithdrawal: null, dailyAmount: null, dailyCount: null, minIntervalMin: null }, base), null);
});
test("recusa acima do máximo por saque", () => {
  assert.match(checkWithdraw({ ...DEFAULT_HOUSE_WITHDRAW }, { ...base, amount: 10000.01 }) ?? "", /máximo por saque/i);
  assert.equal(checkWithdraw({ ...DEFAULT_HOUSE_WITHDRAW }, { ...base, amount: 10000 }), null);
});
test("recusa quando estoura o limite diário em valor", () => {
  assert.match(checkWithdraw({ maxPerWithdrawal: null, dailyAmount: 500, dailyCount: null, minIntervalMin: null }, { ...base, amount: 200, todaySum: 350 }) ?? "", /diário/i);
});
test("recusa quando passa da quantidade diária de saques", () => {
  assert.match(checkWithdraw({ maxPerWithdrawal: null, dailyAmount: null, dailyCount: 2, minIntervalMin: null }, { ...base, todayCount: 2 }) ?? "", /saque\(s\) por dia/i);
});
test("recusa quando o intervalo mínimo ainda não passou", () => {
  const lastAt = new Date(NOW.getTime() - 10 * 60_000); // 10 min atrás
  assert.match(checkWithdraw({ maxPerWithdrawal: null, dailyAmount: null, dailyCount: null, minIntervalMin: 30 }, { ...base, lastAt }) ?? "", /Aguarde/);
  const older = new Date(NOW.getTime() - 40 * 60_000);
  assert.equal(checkWithdraw({ maxPerWithdrawal: null, dailyAmount: null, dailyCount: null, minIntervalMin: 30 }, { ...base, lastAt: older }), null);
});
