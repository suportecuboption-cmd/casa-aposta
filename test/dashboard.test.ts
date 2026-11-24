import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dashPeriod,
  convertC,
  ratio,
  playMetrics,
  paymentMetrics,
  userMetrics,
  type MoneyRow,
  type PixRow,
  type FirstDeposit,
} from "../src/services/dashboard.js";
import { shouldRecordSession, SESSION_EVERY_MS } from "../src/services/activity.js";
import { dashboardParamsSchema } from "../src/schemas/dashboard.js";

/* ── período (guia 8.1) ── */

test("período de hoje termina AGORA e o anterior tem a mesma duração, logo antes", () => {
  const now = new Date("2026-11-24T03:32:00Z"); // 00:32 em São Paulo
  const p = dashPeriod(undefined, undefined, now);
  assert.equal(p.from, "2026-11-24");
  assert.equal(p.live, true);
  assert.equal(p.start.toISOString(), "2026-11-24T03:00:00.000Z"); // 00:00 SP
  assert.equal(p.end.toISOString(), now.toISOString());
  assert.equal(p.prevEnd.toISOString(), p.start.toISOString());
  assert.equal(p.prevStart.toISOString(), "2026-11-24T02:28:00.000Z"); // 23:28 de ontem, não o dia inteiro
});

test("período fechado vai até 00:00 do dia seguinte e compara com os dias logo antes", () => {
  const p = dashPeriod("2026-11-20", "2026-11-22", new Date("2026-11-24T15:00:00Z"));
  assert.equal(p.live, false);
  assert.equal(p.start.toISOString(), "2026-11-20T03:00:00.000Z");
  assert.equal(p.end.toISOString(), "2026-11-23T03:00:00.000Z");
  assert.equal(p.prevStart.toISOString(), "2026-11-17T03:00:00.000Z");
  assert.equal(p.prevEnd.toISOString(), "2026-11-20T03:00:00.000Z");
});

test("período inválido: início depois do fim, mais de 1 ano ou no futuro", () => {
  const now = new Date("2026-11-24T15:00:00Z");
  assert.throws(() => dashPeriod("2026-11-22", "2026-11-20", now));
  assert.throws(() => dashPeriod("2025-01-01", "2026-11-20", now));
  assert.throws(() => dashPeriod("2026-11-30", "2026-11-30", now));
});

/* ── moeda ── */

test("conversão: mesma moeda passa direto; BRL↔USD pela cotação; sem cotação = null", () => {
  assert.equal(convertC(1000, "BRL", { mode: "native", cur: "BRL", rate: null }), 1000);
  assert.equal(convertC(5000, "BRL", { mode: "usd", cur: "USD", rate: 5 }), 1000);
  assert.equal(convertC(1000, "USD", { mode: "usd", cur: "BRL", rate: 5 }), 5000);
  assert.equal(convertC(5000, "BRL", { mode: "usd", cur: "USD", rate: null }), null);
});

test("divisão por zero mostra 0 (ARPU sem usuários ativos)", () => {
  assert.equal(ratio(10, 0), 0);
  assert.equal(ratio(1, 4), 0.25);
});

/* ── cassino: números do guia (24/11) ── */

function guideDay(): MoneyRow[] {
  const rows: MoneyRow[] = [];
  // 89 apostas somando R$ 579,50 (88 × 6,50 + 1 × 7,50), dois jogadores
  for (let i = 0; i < 88; i++) rows.push({ type: "CASINO_BET", c: -650, userId: i % 2 ? "u1" : "u2" });
  rows.push({ type: "CASINO_BET", c: -750, userId: "u1" });
  // 53 prêmios somando R$ 534,54 (52 × 10,00 + 1 × 14,54)
  for (let i = 0; i < 52; i++) rows.push({ type: "CASINO_WIN", c: 1000, userId: "u1" });
  rows.push({ type: "CASINO_WIN", c: 1454, userId: "u2" });
  rows.push({ type: "CASINO_WIN", c: 0, userId: "u2" }); // prêmio zero não conta em "Qtd. de wins"
  return rows;
}

test("cassino: turnover, payout, GGR, hold, RTP e aposta média batem com o guia", () => {
  const { metrics: m, ggrC } = playMetrics(guideDay(), "casino");
  assert.equal(m.bets, 89);
  assert.equal(m.winsCount, 53);
  assert.equal(m.players, 2);
  assert.equal(m.turnover, 579.5);
  assert.equal(m.wins, 534.54);
  assert.equal(m.refunds, 0);
  assert.equal(m.payout, 534.54); // Wins + Refunds
  assert.equal(ggrC, 4496);       // 579,50 − 534,54 (o guia exibe 44,95 por arredondamento deles)
  assert.equal((m.hold * 100).toFixed(2), "7.76");
  assert.equal((m.rtp * 100).toFixed(2), "92.24");
  assert.ok(Math.abs(m.hold + m.rtp - 1) < 1e-9); // Hold % + RTP % = 100%
  assert.equal(m.avgBet.toFixed(2), "6.51");
});

test("cassino: estorno entra no payout; estorno completo (aposta + prêmio) zera o GGR da rodada", () => {
  const rows: MoneyRow[] = [
    { type: "CASINO_BET", c: -5000, userId: "u1" },
    { type: "CASINO_WIN", c: 10000, userId: "u1" },
    { type: "CASINO_REFUND", c: 5000, userId: "u1" },   // devolve a aposta
    { type: "CASINO_REFUND", c: -10000, userId: "u1" }, // retira o prêmio
  ];
  const { metrics: m } = playMetrics(rows, "casino");
  assert.equal(m.payout, 50);
  assert.equal(m.ggr, 0);
});

test("esportes usa os mesmos cálculos com os lançamentos de bilhete", () => {
  const rows: MoneyRow[] = [
    { type: "BET_STAKE", c: -10000, userId: "a" },
    { type: "BET_STAKE", c: -5000, userId: "b" },
    { type: "BET_WIN", c: 39900, userId: "a" },
    { type: "CASINO_BET", c: -999, userId: "c" }, // ignorado no produto esportes
  ];
  const { metrics: m } = playMetrics(rows, "sports");
  assert.equal(m.bets, 2);
  assert.equal(m.turnover, 150);
  assert.equal(m.ggr, -249);
  assert.equal(m.players, 2);
});

/* ── jogadores e monetização ── */

test("ARPU, ARPPU e GGR por player dividem o GGR por bases diferentes", () => {
  const u = userMetrics(4496, 2, 2, 0, 0);
  assert.equal(u.arpu, 0); // nenhum usuário ativo → 0, não erro
  assert.equal(u.arppu, 22.48);
  assert.equal(u.ggrPerPlayer, 22.48);
});

/* ── pagamentos, FTD e retenção ── */

test("depósitos: solicitados pela criação, completados pelo pagamento, líquido desconta a taxa", () => {
  const start = new Date("2026-11-24T03:00:00Z"), end = new Date("2026-11-25T03:00:00Z");
  const at = (h: number) => new Date(start.getTime() + h * 3_600_000);
  const before = new Date("2026-11-20T15:00:00Z");
  const rows: PixRow[] = [
    { id: "d1", kind: "DEPOSIT", status: "PAID", c: 10000, feeC: 100, userId: "ana", createdAt: at(1), paidAt: at(1) },        // FTD
    { id: "d2", kind: "DEPOSIT", status: "PAID", c: 5000, feeC: 0, userId: "ana", createdAt: at(2), paidAt: at(2) },           // redepósito
    { id: "d3", kind: "DEPOSIT", status: "PAID", c: 20000, feeC: 0, userId: "bia", createdAt: before, paidAt: at(3) },         // pedido antes, pago hoje
    { id: "d4", kind: "DEPOSIT", status: "PENDING", c: 7000, feeC: 0, userId: "caio", createdAt: at(4), paidAt: null },        // só solicitado
    { id: "d5", kind: "DEPOSIT", status: "FAILED", c: 3000, feeC: 0, userId: "caio", createdAt: at(5), paidAt: null },         // recusado conta como solicitado
    { id: "w1", kind: "WITHDRAW", status: "PAID", c: 8000, feeC: 50, userId: "bia", createdAt: at(6), paidAt: at(7) },
  ];
  const firsts = new Map<string, FirstDeposit>([
    ["ana", { id: "d1", at: at(1), netC: 9900 }],
    ["bia", { id: "old", at: before, netC: 1000 }], // FTD foi antes do período
  ]);
  const { metrics: m } = paymentMetrics(rows, start, end, firsts, 4);
  assert.equal(m.deposits.requested, 4);   // d1, d2, d4, d5 (d3 foi criado antes)
  assert.equal(m.deposits.completed, 3);   // d1, d2, d3
  assert.equal(m.deposits.net, 349);       // 100 − 1 + 50 + 200
  assert.equal(m.deposits.fee, 1);
  assert.equal(m.deposits.unique, 2);
  assert.equal(m.deposits.avgTicket.toFixed(2), "116.33");
  assert.equal(m.ftd.count, 1);
  assert.equal(m.ftd.net, 99);
  assert.equal(m.ftd.avgTicket, 99);
  assert.equal(m.ftd.share, 0.5);          // 1 FTD ÷ 2 depositantes
  assert.equal(m.ftd.redepositors, 2);     // ana (2º depósito) e bia (já tinha FTD)
  assert.equal(m.ftd.conversion, 0.25);    // 1 FTD ÷ 4 cadastros
  assert.equal(m.ftd.perDepositor, 1.5);
  assert.equal(m.withdrawals.completed, 1);
  assert.equal(m.withdrawals.net, 79.5);
  assert.equal(m.netCashflow, 269.5);      // 349 − 79,50
  assert.equal(m.withdrawDeposit.toFixed(4), (79.5 / 349).toFixed(4));
});

test("sem depósitos, Withdraw/Deposit e participação FTD ficam em 0 (não quebram)", () => {
  const start = new Date("2026-11-24T03:00:00Z"), end = new Date("2026-11-25T03:00:00Z");
  const { metrics: m } = paymentMetrics([], start, end, new Map(), 0);
  assert.equal(m.withdrawDeposit, 0);
  assert.equal(m.ftd.share, 0);
  assert.equal(m.ftd.conversion, 0);
  assert.equal(m.deposits.avgTicket, 0);
});

/* ── acessos e parâmetros ── */

test("sessão aberta só é registrada de novo depois de 15 minutos", () => {
  const t0 = 1_000_000;
  assert.equal(shouldRecordSession(undefined, t0), true);
  assert.equal(shouldRecordSession(t0, t0 + SESSION_EVERY_MS - 1), false);
  assert.equal(shouldRecordSession(t0, t0 + SESSION_EVERY_MS), true);
});

test("parâmetros: aceita cotação, URL e GGR % por carteira; recusa valores fora da faixa", () => {
  const ok = dashboardParamsSchema.safeParse({
    usdBrlRate: 5.4, panelUrl: "https://painel.exemplo.com", wallets: { "OFICIAL - PG Soft": { ggrPct: 14, minBalance: 100 } },
  });
  assert.equal(ok.success, true);
  assert.equal(dashboardParamsSchema.safeParse({ usdBrlRate: null, panelUrl: "", wallets: {} }).success, true);
  assert.equal(dashboardParamsSchema.safeParse({ usdBrlRate: 0, panelUrl: "", wallets: {} }).success, false);
  assert.equal(dashboardParamsSchema.safeParse({ usdBrlRate: null, panelUrl: "nao-e-url", wallets: {} }).success, false);
  assert.equal(dashboardParamsSchema.safeParse({ usdBrlRate: null, panelUrl: "", wallets: { X: { ggrPct: 120, minBalance: 0 } } }).success, false);
});
