import { test } from "node:test";
import assert from "node:assert/strict";
import { matchWallets, normWallet } from "../src/services/casino-wallets.js";

const KNOWN = ["Carteira Oficial (Slots)", "Carteira PlayFiver (Slots)", "Carteira Oficial (Live)", "Carteira SportsBook"];

test("matchWallets: casa as carteiras do agente com as dos provedores, ignorando caixa, acento e espaços", () => {
  const r = matchWallets(["carteira oficial (slots)", "Carteira  Oficial (Live) "], KNOWN);
  assert.deepEqual(r.matched, ["Carteira Oficial (Live)", "Carteira Oficial (Slots)"]);
  assert.deepEqual(r.unmatched, []);
});

test("matchWallets: carteira da conta sem provedor no catálogo vai para unmatched (não habilita nada)", () => {
  const r = matchWallets(["Carteira Pragmatic (Russian)", "Carteira SportsBook"], KNOWN);
  assert.deepEqual(r.matched, ["Carteira SportsBook"]);
  assert.deepEqual(r.unmatched, ["Carteira Pragmatic (Russian)"]);
});

test("matchWallets: conta sem carteiras = nada habilitado", () => {
  assert.deepEqual(matchWallets([], KNOWN), { matched: [], unmatched: [] });
});

test("normWallet: normaliza acento, caixa e espaços", () => {
  assert.equal(normWallet("  Carteira  Alto Padrão "), "carteira alto padrao");
});
