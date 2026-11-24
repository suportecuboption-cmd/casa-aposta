import { test } from "node:test";
import assert from "node:assert/strict";
import { buildInvoice, invoiceStatus, monthDays, monthWeeks, type ProviderDay } from "../src/services/invoices.js";

const pct = (table: Record<string, number | null>) => (p: string) => (p in table ? table[p] : null);

/* ── buildInvoice: custo = GGR positivo × % ── */
test("custo do provedor usa só GGR positivo e respeita o % de cada um", () => {
  const rows: ProviderDay[] = [
    { provider: "Pragmatic", day: "2026-11-01", ggrC: 100_00 },
    { provider: "Sportsbook", day: "2026-11-02", ggrC: 200_00 },
  ];
  const inv = buildInvoice("2026-11", rows, pct({ Pragmatic: 10, Sportsbook: 5 }));
  const prag = inv.providers.find((p) => p.name === "Pragmatic")!;
  assert.equal(prag.ggr, 100);
  assert.equal(prag.cost, 10); // 100 × 10%
  assert.equal(inv.totalCost, 20); // 10 + (200 × 5% = 10)
  assert.equal(inv.missingPct, false);
});

test("GGR negativo não gera custo e é sinalizado; provedor sem % fica como pendente", () => {
  const rows: ProviderDay[] = [
    { provider: "Loss", day: "2026-11-03", ggrC: -50_00 },
    { provider: "SemPct", day: "2026-11-04", ggrC: 80_00 },
  ];
  const inv = buildInvoice("2026-11", rows, pct({ Loss: 10 })); // SemPct não tem %
  const loss = inv.providers.find((p) => p.name === "Loss")!;
  assert.equal(loss.cost, 0);
  assert.equal(loss.negative, true);
  const semPct = inv.providers.find((p) => p.name === "SemPct")!;
  assert.equal(semPct.cost, null);
  assert.equal(inv.missingPct, true);
});

test("o custo semanal e diário não têm piso: pode ficar negativo (como no Axio)", () => {
  const rows: ProviderDay[] = [{ provider: "P", day: "2026-11-02", ggrC: -100_00 }];
  const inv = buildInvoice("2026-11", rows, pct({ P: 10 }));
  assert.equal(inv.totalCost, 0); // provedor: só GGR positivo
  const week1 = inv.weeks.find((w) => w.n === 1)!;
  assert.equal(week1.cost, -10); // −100 × 10% = −10, sem piso
  assert.equal(week1.days.find((d) => d.day === "2026-11-02")!.cost, -10);
});

/* ── semanas e dias ── */
test("semanas: 1–7, 8–14, 15–21, 22–28 e a 5ª vai do 29 ao fim do mês", () => {
  const w = monthWeeks("2026-11"); // novembro tem 30 dias
  assert.equal(w.length, 5);
  assert.deepEqual([w[0].days[0], w[0].days[6]], ["2026-11-01", "2026-11-07"]);
  assert.deepEqual(w[4].days, ["2026-11-29", "2026-11-30"]);
});
test("monthDays conhece fevereiro comum e bissexto", () => {
  assert.equal(monthDays("2026-02").length, 28);
  assert.equal(monthDays("2024-02").length, 29);
});

/* ── invoiceStatus ── */
test("mês atual fica Parcial (publicado ou pagamento parcial)", () => {
  assert.equal(invoiceStatus("2026-11", "2026-11", 100, 0), "Parcial publicado");
  assert.equal(invoiceStatus("2026-11", "2026-11", 100, 30), "Parcial · pagamento parcial");
});
test("mês fechado: Sem custo, Pago, Pagamento parcial ou Em aberto", () => {
  assert.equal(invoiceStatus("2026-10", "2026-11", 0, 0), "Sem custo");
  assert.equal(invoiceStatus("2026-10", "2026-11", 100, 100), "Pago");
  assert.equal(invoiceStatus("2026-10", "2026-11", 100, 40), "Pagamento parcial");
  assert.equal(invoiceStatus("2026-10", "2026-11", 100, 0), "Em aberto");
});
