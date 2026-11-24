import { test } from "node:test";
import assert from "node:assert/strict";
import { Decimal } from "@prisma/client/runtime/library";
import { resolveSlip } from "../src/services/betslip.js";
import { createEventSchema, updateEventSchema } from "../src/schemas/event.js";

const D = (v: number | string) => new Decimal(v);
const leg = (status: "OPEN" | "WON" | "LOST" | "VOID", odds: number) => ({ status, odds: D(odds) });

/* ── resolveSlip: decide o bilhete a partir das pernas ── */

test("bilhete: qualquer perna perdida fecha como LOST sem pagamento", () => {
  const r = resolveSlip(D(10), [leg("WON", 2), leg("LOST", 3), leg("OPEN", 1.5)]);
  assert.equal(r.status, "LOST");
  assert.equal(r.payout?.toString(), "0");
});

test("bilhete: todas as pernas ganhas pagam stake × odd combinada", () => {
  const r = resolveSlip(D(10), [leg("WON", 2.1), leg("WON", 1.9)]); // 3.99
  assert.equal(r.status, "WON");
  assert.equal(r.payout?.toString(), "39.9");
});

test("bilhete: com perna ainda aberta segue OPEN e sem pagamento", () => {
  const r = resolveSlip(D(10), [leg("WON", 2), leg("OPEN", 3)]);
  assert.equal(r.status, "OPEN");
  assert.equal(r.payout, null);
  assert.equal(r.potentialReturn.toString(), "60");
});

test("bilhete: perna anulada conta como odd 1.00 (acumulada recalculada)", () => {
  const open = resolveSlip(D(10), [leg("VOID", 2.5), leg("OPEN", 3)]);
  assert.equal(open.status, "OPEN");
  assert.equal(open.combinedOdds.toString(), "3");
  assert.equal(open.potentialReturn.toString(), "30");
  const won = resolveSlip(D(10), [leg("VOID", 2.5), leg("WON", 3)]);
  assert.equal(won.status, "WON");
  assert.equal(won.payout?.toString(), "30");
});

test("bilhete: todas as pernas anuladas devolvem a aposta (VOID)", () => {
  const r = resolveSlip(D(25), [leg("VOID", 2), leg("VOID", 4)]);
  assert.equal(r.status, "VOID");
  assert.equal(r.payout?.toString(), "25");
});

/* ── schemas de evento ── */

const base = {
  league: "Brasileirão Série A",
  homeTeam: "Flamengo",
  awayTeam: "Palmeiras",
  startsAt: "2026-12-01T20:00:00.000Z",
  oddsHome: 2.1,
  oddsDraw: 3.4,
  oddsAway: 3.2,
};

test("evento: cadastro converte a data e começa fora do ao vivo", () => {
  const r = createEventSchema.parse(base);
  assert.ok(r.startsAt instanceof Date);
  assert.equal(r.startsAt.toISOString(), "2026-12-01T20:00:00.000Z");
  assert.equal(r.isLive, false);
});

test("evento: empate é opcional (mercado sem empate)", () => {
  const { oddsDraw, ...semEmpate } = base;
  assert.equal(createEventSchema.safeParse(semEmpate).success, true);
  assert.equal(createEventSchema.safeParse({ ...base, oddsDraw: null }).success, true);
});

test("evento: recusa times iguais, odd abaixo de 1,01 e data inválida", () => {
  assert.equal(createEventSchema.safeParse({ ...base, awayTeam: "flamengo" }).success, false);
  assert.equal(createEventSchema.safeParse({ ...base, oddsHome: 1 }).success, false);
  assert.equal(createEventSchema.safeParse({ ...base, startsAt: "amanhã" }).success, false);
  assert.equal(createEventSchema.safeParse({ ...base, startsAt: "" }).success, false);
});

test("evento: edição aceita campo isolado e recusa corpo vazio", () => {
  assert.equal(updateEventSchema.safeParse({ oddsHome: 1.85 }).success, true);
  assert.equal(updateEventSchema.safeParse({ isLive: true }).success, true);
  assert.equal(updateEventSchema.safeParse({}).success, false);
});
