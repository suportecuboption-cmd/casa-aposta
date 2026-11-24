import { test } from "node:test";
import assert from "node:assert/strict";
import { makePeriod, summarizeLedger, summarizeByGame, productMetrics, dayKey } from "../src/services/reports.js";

/* ── relatórios: período, fuso e agregação ── */

test("período: datas de São Paulo viram instantes UTC (-03:00) e padrão é últimos 7 dias", () => {
  const p = makePeriod("2026-11-15", "2026-11-21");
  assert.equal(p.days.length, 7);
  assert.equal(p.start.toISOString(), "2026-11-15T03:00:00.000Z");
  assert.equal(p.end.toISOString(), "2026-11-22T03:00:00.000Z");
  const d = makePeriod(undefined, undefined, new Date("2026-11-21T12:00:00Z"));
  assert.deepEqual([d.from, d.to], ["2026-11-15", "2026-11-21"]);
  assert.throws(() => makePeriod("2026-11-21", "2026-11-15"));
});

test("fuso: 02:30 UTC ainda é o dia anterior em São Paulo", () => {
  assert.equal(dayKey(new Date("2026-11-21T02:30:00Z")), "2026-11-20");
  assert.equal(dayKey(new Date("2026-11-21T03:00:00Z")), "2026-11-21");
});

const at = (iso: string) => new Date(iso);
const rows = [
  { type: "DEPOSIT", amount: 100, createdAt: at("2026-11-20T15:00:00Z"), userId: "u1" },
  { type: "WITHDRAW", amount: -30, createdAt: at("2026-11-20T16:00:00Z"), userId: "u1" },
  { type: "BET_STAKE", amount: -10, createdAt: at("2026-11-20T17:00:00Z"), userId: "u1" },
  { type: "BET_STAKE", amount: -5, createdAt: at("2026-11-20T17:05:00Z"), userId: "u1" },
  { type: "BET_REFUND", amount: 5, createdAt: at("2026-11-21T10:00:00Z"), userId: "u1" },
  { type: "BET_WIN", amount: 25, createdAt: at("2026-11-21T10:00:00Z"), userId: "u1" },
  { type: "CASINO_BET", amount: -1, createdAt: at("2026-11-21T02:30:00Z"), userId: "u2", gameId: "g1" }, // ainda dia 20 em SP
  { type: "CASINO_BET", amount: -1, createdAt: at("2026-11-21T12:00:00Z"), userId: "u2", gameId: "g1" },
  { type: "CASINO_BET", amount: -1, createdAt: at("2026-11-21T12:01:00Z"), userId: "u3", gameId: "g2" },
  { type: "CASINO_WIN", amount: 0.1, createdAt: at("2026-11-21T12:00:00Z"), userId: "u2", gameId: "g1" },
  { type: "CASINO_WIN", amount: 0.2, createdAt: at("2026-11-21T12:01:00Z"), userId: "u3", gameId: "g2" },
  { type: "CASINO_REFUND", amount: 1, createdAt: at("2026-11-21T12:02:00Z"), userId: "u3", gameId: "g2" },
  { type: "BONUS", amount: 10, createdAt: at("2026-11-21T13:00:00Z"), userId: "u1" },
];

test("relatório: GGR = apostas líquidas − prêmios, RTP = prêmios ÷ apostas, NGR desconta bônus", () => {
  const s = summarizeLedger(rows, ["2026-11-20", "2026-11-21"]);
  assert.deepEqual([s.deposits, s.withdrawals, s.netDeposits], [100, 30, 70]);
  assert.deepEqual(s.sports, { stake: 15, refunds: 5, turnover: 10, wins: 25, ggr: -15, rtp: 2.5 });
  assert.equal(s.casino.turnover, 2);
  assert.equal(s.casino.wins, 0.3); // 0,1 + 0,2 somados em centavos: sem 0,30000000000000004
  assert.equal(s.casino.ggr, 1.7);
  assert.equal(s.total.ggr, -13.3);
  assert.equal(s.total.ngr, -23.3);
  assert.deepEqual(s.counts, { deposits: 1, withdrawals: 1, sportsBets: 2, casinoRounds: 3 });
  assert.equal(s.activePlayers, 3);
  assert.equal(s.depositors, 1);
});

test("relatório: dias separados pelo fuso de São Paulo", () => {
  const s = summarizeLedger(rows, ["2026-11-20", "2026-11-21"]);
  const [d20, d21] = s.daily;
  assert.equal(d20.turnover, 16); // 10 + 5 de esportes + 1 rodada às 23:30 de SP
  assert.equal(d21.turnover, -5 + 1); // devolução de 5 no dia 21; 2 rodadas − 1 estorno = 1
  assert.equal(d20.deposits, 100);
});

test("relatório por jogo: rodadas, jogadores distintos, GGR e RTP", () => {
  const g = Object.fromEntries(summarizeByGame(rows).map((x) => [x.gameId, x]));
  assert.equal(g.g1.rounds, 2);
  assert.equal(g.g1.players, 1);
  assert.equal(g.g1.ggr, 1.9);
  assert.equal(g.g2.turnover, 0); // apostou 1 e foi estornado
  assert.equal(g.g2.rtp, null);
  assert.equal(productMetrics(0, 0, 0).rtp, null);
});
