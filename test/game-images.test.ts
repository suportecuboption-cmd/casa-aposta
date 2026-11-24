import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { thumbName, isRemoteImage, isLocalThumb, makeThumb, syncImageChange, parseMeta, coversFirst } from "../src/services/game-images.js";

const API = { original: false, code: "126", provider: "OFICIAL - PG SOFT" };
const CDN = "https://imagensfivers.com/Games/PG-Soft/PGS_126.webp";

test("syncImageChange: miniatura nossa fica; arte nova na PlayFivers faz baixar de novo", () => {
  const cur = { imageUrl: "/uploads/games/g1-abc.webp", meta: JSON.stringify({ ...API, remoteImage: CDN }) };
  const same = syncImageChange(cur, CDN, API);
  assert.equal(same.imageUrl, undefined);
  assert.equal(parseMeta(same.meta).remoteImage, CDN); // o meta regravado pela sincronização não perde a URL original
  assert.equal(syncImageChange(cur, CDN.replace("126", "999"), API).imageUrl, CDN.replace("126", "999"));
});

test("syncImageChange: capa do admin nunca muda; URL que deu 404 não volta (URL nova tenta de novo)", () => {
  assert.equal(syncImageChange({ imageUrl: "/uploads/game-1-ff.png", meta: null }, CDN, API).imageUrl, undefined);
  const missing = { imageUrl: null, meta: JSON.stringify({ ...API, imageMissing: CDN }) };
  assert.equal(syncImageChange(missing, CDN, API).imageUrl, undefined);
  assert.equal(parseMeta(syncImageChange(missing, CDN, API).meta).imageMissing, CDN);
  assert.equal(syncImageChange(missing, CDN + "?v=2", API).imageUrl, CDN + "?v=2");
});

test("syncImageChange: capa remota comum segue a PlayFivers", () => {
  assert.equal(syncImageChange({ imageUrl: CDN, meta: null }, CDN, API).imageUrl, undefined);
  assert.equal(syncImageChange({ imageUrl: CDN, meta: null }, CDN + "x", API).imageUrl, CDN + "x");
  assert.equal(parseMeta("{quebrado").imageMissing, undefined);
});

test("coversFirst: jogo com capa vem antes; 'Em alta' e a ordem manual do admin não mudam; o nome segue desempatando", () => {
  const g = (name: string, imageUrl: string | null, featured = false, sortOrder = 0) => ({ name, imageUrl, featured, sortOrder });
  // Como vem do banco: featured desc, sortOrder asc, name asc.
  const fromDb = [
    g("Zeus Em Alta", null, true, 0), g("Aztec Em Alta", "/uploads/games/a.webp", true, 1),
    g("Aztec", null), g("Book", "/uploads/games/b.webp"), g("Candy", null),
    g("Dragon", "https://imagensfivers.com/Games/x.webp"), // capa ainda na CDN também conta
    g("Manual", null, false, 3),
  ];
  assert.deepEqual(coversFirst(fromDb).map((x) => x.name), ["Zeus Em Alta", "Aztec Em Alta", "Book", "Dragon", "Aztec", "Candy", "Manual"]);
  assert.deepEqual(coversFirst([]), []);
});

test("thumbName: id do jogo + hash do conteúdo (mesmo conteúdo = mesmo nome; outro = outro nome)", () => {
  const a = thumbName("g1", Buffer.from("abc"));
  assert.match(a, /^g1-[0-9a-f]{10}\.webp$/);
  assert.equal(thumbName("g1", Buffer.from("abc")), a);
  assert.notEqual(thumbName("g1", Buffer.from("abd")), a);
});

test("isRemoteImage / isLocalThumb", () => {
  assert.equal(isRemoteImage("https://imagensfivers.com/Games/PG-Soft/PGS_7.webp"), true);
  assert.equal(isRemoteImage("/uploads/games/x.webp"), false);
  assert.equal(isRemoteImage(null), false);
  assert.equal(isLocalThumb("/uploads/games/x.webp"), true);
  assert.equal(isLocalThumb("/uploads/banner.png"), false);
});

test("makeThumb: reduz para 360 px de largura em WEBP e não amplia imagem pequena", async () => {
  const big = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 200, g: 40, b: 40 } } }).png().toBuffer();
  const t = await makeThumb(big);
  const m = await sharp(t).metadata();
  assert.deepEqual([m.format, m.width, m.height], ["webp", 360, 270]);
  const small = await sharp({ create: { width: 200, height: 200, channels: 3, background: "#123456" } }).png().toBuffer();
  assert.equal((await sharp(await makeThumb(small)).metadata()).width, 200);
  await assert.rejects(makeThumb(Buffer.from("<html>404</html>"))); // página de erro não vira capa
});
