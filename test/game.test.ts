import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameSchema, updateGameSchema } from "../src/schemas/game.js";

const base = { providerSlug: "pg-soft", slug: "fortune-tiger", name: "Fortune Tiger", category: "slots" };

test("jogo: cadastro mínimo aplica padrões (ativo, sem demo, não ao vivo)", () => {
  const r = createGameSchema.parse(base);
  assert.equal(r.isActive, true);
  assert.equal(r.hasDemo, false);
  assert.equal(r.isLive, false);
  assert.equal(r.imageUrl, undefined);
});

test("jogo: slug e categoria são normalizados para minúsculas", () => {
  const r = createGameSchema.parse({ ...base, slug: "  Fortune-Tiger ", category: " SLOTS " });
  assert.equal(r.slug, "fortune-tiger");
  assert.equal(r.category, "slots");
});

test("jogo: slug rejeita espaços, acentos e hífens soltos", () => {
  for (const slug of ["fortune tiger", "clássico", "-tiger", "tiger-", "a--b", ""]) {
    assert.equal(createGameSchema.safeParse({ ...base, slug }).success, false, `slug "${slug}"`);
  }
});

test("jogo: exige nome, provedor e categoria", () => {
  assert.equal(createGameSchema.safeParse({ ...base, name: " " }).success, false);
  assert.equal(createGameSchema.safeParse({ ...base, providerSlug: "" }).success, false);
  assert.equal(createGameSchema.safeParse({ ...base, category: "" }).success, false);
});

test("jogo: imagem aceita caminho local, https ou vazio e recusa javascript:", () => {
  assert.equal(createGameSchema.safeParse({ ...base, imageUrl: "/uploads/game-1.png" }).success, true);
  assert.equal(createGameSchema.safeParse({ ...base, imageUrl: "https://cdn.exemplo.com/a.webp" }).success, true);
  assert.equal(createGameSchema.safeParse({ ...base, imageUrl: "" }).success, true);
  assert.equal(createGameSchema.safeParse({ ...base, imageUrl: "javascript:alert(1)" }).success, false);
});

test("jogo: edição aceita um campo isolado e recusa corpo vazio", () => {
  assert.equal(updateGameSchema.safeParse({ isActive: false }).success, true);
  assert.equal(updateGameSchema.safeParse({}).success, false);
});
