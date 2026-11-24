import { test } from "node:test";
import assert from "node:assert/strict";
import {
  depositSchema,
  withdrawSchema,
  WALLET_LIMITS,
} from "../src/schemas/wallet.js";

test("limites de depósito expostos como constantes", () => {
  assert.equal(WALLET_LIMITS.deposit.min, 5);
  assert.equal(WALLET_LIMITS.deposit.max, 50_000);
});

test("depósito aceita o mínimo (5 BRL)", () => {
  const r = depositSchema.safeParse({ amount: 5 });
  assert.equal(r.success, true);
});

test("depósito aceita o máximo (50000 BRL)", () => {
  const r = depositSchema.safeParse({ amount: 50_000 });
  assert.equal(r.success, true);
});

test("depósito aceita valor intermediário", () => {
  const r = depositSchema.safeParse({ amount: 250.5 });
  assert.equal(r.success, true);
});

test("depósito rejeita abaixo do mínimo (4.99)", () => {
  const r = depositSchema.safeParse({ amount: 4.99 });
  assert.equal(r.success, false);
});

test("depósito rejeita zero e negativos", () => {
  assert.equal(depositSchema.safeParse({ amount: 0 }).success, false);
  assert.equal(depositSchema.safeParse({ amount: -10 }).success, false);
});

test("depósito rejeita acima do máximo (50000.01)", () => {
  const r = depositSchema.safeParse({ amount: 50_000.01 });
  assert.equal(r.success, false);
});

test("depósito rejeita tipo não numérico", () => {
  assert.equal(depositSchema.safeParse({ amount: "100" }).success, false);
  assert.equal(depositSchema.safeParse({}).success, false);
});

test("saque respeita mínimo próprio (20 BRL)", () => {
  assert.equal(withdrawSchema.safeParse({ amount: 19.99 }).success, false);
  assert.equal(withdrawSchema.safeParse({ amount: 20 }).success, true);
  assert.equal(withdrawSchema.safeParse({ amount: 50_000 }).success, true);
  assert.equal(withdrawSchema.safeParse({ amount: 50_000.01 }).success, false);
});
