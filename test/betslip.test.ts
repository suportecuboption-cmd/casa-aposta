import { test } from "node:test";
import assert from "node:assert/strict";
import { Decimal } from "@prisma/client/runtime/library";
import {
  computeCombinedOdds,
  computePotentialReturn,
  oddForSelection,
} from "../src/services/betslip.js";
import { placeBetslipSchema, MAX_SELECTIONS } from "../src/schemas/betslip.js";

const D = (v: number | string) => new Decimal(v);

test("odd combinada de aposta simples = a própria odd", () => {
  assert.equal(computeCombinedOdds([D(2.1)]).toString(), "2.1");
});

test("odd combinada de acumulada = produto das odds", () => {
  // 2.1 * 1.9 * 3.2 = 12.768
  assert.equal(computeCombinedOdds([D(2.1), D(1.9), D(3.2)]).toString(), "12.768");
});

test("retorno potencial = stake × odd combinada (2 casas)", () => {
  const combined = computeCombinedOdds([D(2.1), D(1.9)]); // 3.99
  assert.equal(computePotentialReturn(D(100), combined).toString(), "399");
  assert.equal(computePotentialReturn(D(50), D(2.5)).toString(), "125");
});

test("oddForSelection resolve mercado 1X2 e retorna null sem empate", () => {
  const ev = { oddsHome: D(2), oddsDraw: null, oddsAway: D(3) };
  assert.equal(oddForSelection(ev, "home").toString(), "2");
  assert.equal(oddForSelection(ev, "away").toString(), "3");
  assert.equal(oddForSelection(ev, "draw"), null);
});

test("schema aceita bilhete simples", () => {
  const r = placeBetslipSchema.safeParse({
    stake: 10,
    selections: [{ eventId: "e1", selection: "home" }],
  });
  assert.equal(r.success, true);
});

test("schema aplica default de market 1X2", () => {
  const r = placeBetslipSchema.parse({
    stake: 10,
    selections: [{ eventId: "e1", selection: "home" }],
  });
  assert.equal(r.selections[0].market, "1X2");
});

test("schema rejeita seleções duplicadas do mesmo evento", () => {
  const r = placeBetslipSchema.safeParse({
    stake: 10,
    selections: [
      { eventId: "e1", selection: "home" },
      { eventId: "e1", selection: "away" },
    ],
  });
  assert.equal(r.success, false);
});

test("schema rejeita bilhete sem seleções e acima do máximo", () => {
  assert.equal(placeBetslipSchema.safeParse({ stake: 10, selections: [] }).success, false);
  const many = Array.from({ length: MAX_SELECTIONS + 1 }, (_, i) => ({
    eventId: "e" + i,
    selection: "home" as const,
  }));
  assert.equal(placeBetslipSchema.safeParse({ stake: 10, selections: many }).success, false);
});

test("schema respeita limites de stake", () => {
  const sel = [{ eventId: "e1", selection: "home" as const }];
  assert.equal(placeBetslipSchema.safeParse({ stake: 0, selections: sel }).success, false);
  assert.equal(placeBetslipSchema.safeParse({ stake: 10_001, selections: sel }).success, false);
});
