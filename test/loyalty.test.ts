import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { wageredFrom } from "../src/services/loyalty.js";
import { normalizeLevels, vipStatus, parseVip, levelKey, DEFAULT_VIP_LEVELS } from "../src/services/vip.js";
import { packsState, pickCards, parseCollectionsSettings, rankSearch } from "../src/services/collections.js";
import { appManifest, renderAppIcon, iconVersion, DEFAULT_BRAND } from "../src/services/brand.js";
import { vipConfigSchema, collectionInputSchema, collectionsSettingsSchema } from "../src/schemas/loyalty.js";

test("wageredFrom: apostas (negativas no extrato) menos estornos; nunca negativo", () => {
  assert.equal(wageredFrom([{ type: "CASINO_BET", sum: -150 }, { type: "BET_STAKE", sum: -50.5 }, { type: "CASINO_REFUND", sum: 20 }]), 180.5);
  assert.equal(wageredFrom([{ type: "CASINO_REFUND", sum: 10 }]), 0);
  assert.equal(wageredFrom([]), 0);
});

test("normalizeLevels: ordena pelo total, tira nome repetido e valor negativo", () => {
  const lv = normalizeLevels([
    { name: "Ouro", minWagered: 5000, reward: 50, color: "#d99a00" },
    { name: "Bronze", minWagered: -3, reward: -1, color: "vermelho" },
    { name: "ouro", minWagered: 1, reward: 1 },
    { name: "  ", minWagered: 10 },
  ]);
  assert.deepEqual(lv.map((l) => [l.name, l.minWagered, l.reward, l.color]), [["Bronze", 0, 0, "#8f9aab"], ["Ouro", 5000, 50, "#d99a00"]]);
  assert.equal(levelKey("  Diamante "), "diamante");
});

test("vipStatus: nível atual, próximo, progresso e quanto falta", () => {
  const lv = DEFAULT_VIP_LEVELS; // 0 · 1.000 · 5.000 · 20.000 · 100.000
  assert.deepEqual(vipStatus(lv, 0), { current: 0, next: 1, progress: 0, toNext: 1000 });
  assert.deepEqual(vipStatus(lv, 3000), { current: 1, next: 2, progress: 0.5, toNext: 2000 });
  assert.deepEqual(vipStatus(lv, 250000), { current: 4, next: null, progress: 1, toNext: 0 });
  assert.deepEqual(vipStatus(normalizeLevels([{ name: "Prata", minWagered: 100 }]), 40), { current: -1, next: 0, progress: 0.4, toNext: 60 });
});

test("parseVip: vazio ou quebrado = níveis padrão; lista vazia não apaga os níveis", () => {
  assert.equal(parseVip(null).levels.length, 5);
  assert.equal(parseVip("{x").enabled, true);
  assert.equal(parseVip(JSON.stringify({ enabled: false, levels: [] })).levels.length, 5);
  assert.equal(parseVip(JSON.stringify({ enabled: false, levels: [{ name: "Único", minWagered: 0 }] })).levels[0].name, "Único");
});

test("packsState: 1 pacote a cada R$ X apostados; já abertos descontam; quanto falta para o próximo", () => {
  assert.deepEqual(packsState(0, 100, 0), { earned: 0, opened: 0, available: 0, nextIn: 100 });
  assert.deepEqual(packsState(350, 100, 1), { earned: 3, opened: 1, available: 2, nextIn: 50 });
  assert.deepEqual(packsState(300, 100, 5), { earned: 3, opened: 5, available: 0, nextIn: 100 });
  assert.equal(packsState(0.3 * 1000, 100, 0).earned, 3); // sem erro de arredondamento
});

test("pickCards: não repete no pacote, favorece carta que falta e respeita o tamanho do álbum", () => {
  const all = ["a", "b", "c", "d"];
  const seq = [0.1, 0.0, 0.1, 0.0, 0.1, 0.0]; // sempre "faltando" e o primeiro da lista
  let i = 0;
  const picked = pickCards(all, new Set(["a", "b"]), 2, () => seq[i++] ?? 0);
  assert.deepEqual(picked, ["c", "d"]);
  assert.equal(new Set(pickCards(all, new Set(), 4)).size, 4);
  assert.equal(pickCards(["x"], new Set(), 3).length, 1);
  assert.deepEqual(pickCards([], new Set(), 3), []);
});

test("rankSearch: quem começa com o texto vem antes; ativo e com capa na frente", () => {
  const g = (name: string, isActive = true, imageUrl: string | null = "/x.webp") => ({ name, isActive, imageUrl });
  const out = rankSearch([g("Alibaba's Cave of Fortune"), g("Fortune Tiger", false), g("Fortune Ox"), g("Fortune Mouse", true, null), g("Double Fortune")], "fortune");
  assert.deepEqual(out.map((x) => x.name), ["Fortune Ox", "Fortune Mouse", "Fortune Tiger", "Alibaba's Cave of Fortune", "Double Fortune"]);
});

test("parseCollectionsSettings e schemas: valores fora do limite não entram", () => {
  assert.deepEqual([parseCollectionsSettings(null).packEvery, parseCollectionsSettings(null).cardsPerPack], [100, 3]);
  assert.equal(parseCollectionsSettings(JSON.stringify({ packEvery: 0, cardsPerPack: 99 })).cardsPerPack, 3);
  assert.equal(collectionsSettingsSchema.safeParse({ enabled: true, packEvery: 0, cardsPerPack: 3 }).success, false);
  assert.equal(collectionInputSchema.safeParse({ name: "X", reward: 10, gameIds: [] }).success, false);
  assert.equal(vipConfigSchema.safeParse({ enabled: true, levels: [{ name: "A", minWagered: 0, reward: -5 }] }).success, false);
});

test("appManifest e ícone do app: nome da Marca, ícones com versão e PNG do tamanho certo", async () => {
  const m = appManifest({ ...DEFAULT_BRAND, name: "Minha Casa de Apostas" });
  assert.equal(m.name, "Minha Casa de Apostas");
  assert.equal(m.short_name.length <= 12, true);
  assert.equal(m.start_url.startsWith("/app/"), true);
  assert.ok(m.icons.some((i) => i.purpose === "maskable" && i.sizes === "512x512"));
  assert.ok(m.icons.every((i) => i.src.includes(`?v=${iconVersion(DEFAULT_BRAND)}`)));
  assert.notEqual(iconVersion(DEFAULT_BRAND), iconVersion({ ...DEFAULT_BRAND, iconUrl: "/uploads/brand-icon-x.png" }));
  const png = await sharp(await renderAppIcon(DEFAULT_BRAND, 192, false)).metadata();
  assert.deepEqual([png.format, png.width, png.height], ["png", 192, 192]);
  const mask = await sharp(await renderAppIcon(DEFAULT_BRAND, 512, true)).metadata();
  assert.deepEqual([mask.width, mask.height], [512, 512]);
});
