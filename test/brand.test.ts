import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
  DEFAULT_BRAND, parseBrand, mergeBrand, brandMarkup, renderPlayerHtml, renderBrandImage, processBrandImage, isBrandImage,
} from "../src/services/brand.js";
import { brandSchema } from "../src/schemas/brand.js";

const LOGO = "/uploads/brand-logo-abc123.png";
const DARK = "/uploads/brand-logo-def456.png";
const ICON = "/uploads/brand-icon-0a1b2c.png";

test("parseBrand: vazio ou quebrado = marca padrão; imagem de fora e altura absurda não entram", () => {
  assert.equal(parseBrand(null).name, "casaAPOSTA");
  assert.equal(parseBrand("{quebrado").wordB, "APOSTA");
  assert.equal(parseBrand("[1,2]").logoHeight, 32);
  const b = parseBrand(JSON.stringify({
    name: "  ", wordA: "Bet", logoUrl: "https://outro.site/logo.png", iconUrl: "javascript:alert(1)", logoDarkUrl: DARK, logoHeight: 999,
  }));
  assert.equal(b.name, "casaAPOSTA"); // nome em branco volta ao padrão
  assert.equal(b.wordA, "Bet");
  assert.equal(b.logoUrl, null);
  assert.equal(b.iconUrl, null);
  assert.equal(b.logoDarkUrl, DARK);
  assert.equal(b.logoHeight, 64);
  assert.equal(parseBrand(JSON.stringify({ logoHeight: 2 })).logoHeight, 18);
  assert.equal(isBrandImage(LOGO), true);
  assert.equal(isBrandImage("/uploads/../segredo"), false);
});

test("mergeBrand: campo ausente mantém; tirar a logo tira a versão escura; nome em branco não apaga", () => {
  const cur = { ...DEFAULT_BRAND, logoUrl: LOGO, logoDarkUrl: DARK, iconUrl: ICON };
  const kept = mergeBrand(cur, { wordA: "Mega" });
  assert.equal(kept.logoUrl, LOGO);
  assert.equal(kept.logoDarkUrl, DARK);
  assert.equal(kept.wordA, "Mega");
  const noLogo = mergeBrand(cur, { logoUrl: null });
  assert.equal(noLogo.logoDarkUrl, null);
  assert.equal(noLogo.iconUrl, ICON);
  assert.equal(mergeBrand(cur, { name: "   " }).name, "casaAPOSTA");
  assert.equal(mergeBrand(cur, { logoHeight: 500 }).logoHeight, 64);
});

test("brandMarkup: texto em duas cores com o hexágono; imagem substitui; tema escuro tem a sua; tudo escapado", () => {
  const def = brandMarkup(DEFAULT_BRAND);
  assert.match(def, /<svg class="ic"/);
  assert.match(def, /<span class="wm">casa<b>APOSTA<\/b><\/span>/);
  assert.match(brandMarkup({ ...DEFAULT_BRAND, wordA: "", wordB: "" }), /<span class="wm">casaAPOSTA<\/span>/);
  const withIcon = brandMarkup({ ...DEFAULT_BRAND, iconUrl: ICON });
  assert.ok(withIcon.includes(`<img class="ic" src="${ICON}"`) && !withIcon.includes("<svg"));
  const img = brandMarkup({ ...DEFAULT_BRAND, name: 'A&B "Bet"', logoUrl: LOGO, logoHeight: 40 });
  assert.equal(img, `<img class="logo" src="${LOGO}" alt="A&amp;B &quot;Bet&quot;" style="--logo-h:40px">`);
  const both = brandMarkup({ ...DEFAULT_BRAND, logoUrl: LOGO, logoDarkUrl: DARK });
  assert.ok(both.includes('class="logo logo-light"') && both.includes(`class="logo logo-dark" src="${DARK}"`));
  assert.match(brandMarkup({ ...DEFAULT_BRAND, wordA: "<b>x</b>" }), /&lt;b&gt;x&lt;\/b&gt;<b>/);
});

test("renderPlayerHtml: título, logo, nome e favicon no HTML; window.SITE_BRAND não quebra o <script>", () => {
  const tpl = `<head><title>casa-aposta</title><link rel="icon" href="data:image/svg+xml,x" /></head>
<body><a class="brand"><!--brand-->ANTIGA<!--/brand--></a><p>Bem-vindo ao <!--brand-name-->velho<!--/brand-name--></p></body>`;
  const def = renderPlayerHtml(tpl, DEFAULT_BRAND);
  assert.match(def, /<title>casaAPOSTA<\/title>/);
  assert.match(def, /<link rel="icon" href="data:image\/svg\+xml,x" \/>/); // sem ícone enviado, fica o padrão
  assert.match(def, /<!--brand--><svg class="ic"[\s\S]*<!--\/brand-->/);
  assert.match(def, /Bem-vindo ao <!--brand-name-->casaAPOSTA<!--\/brand-name-->/);
  assert.ok(!def.includes("ANTIGA"));
  assert.match(def, /<script>window\.SITE_BRAND = \{"name":"casaAPOSTA"[^<]*<\/script>\n<\/head>/);

  const evil = { ...DEFAULT_BRAND, name: "</script><script>alert(1)</script>", iconUrl: ICON };
  const html = renderPlayerHtml(tpl, evil);
  assert.match(html, /<title>&lt;\/script&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/title>/);
  assert.equal(html.split("</script>").length, 2); // só o fechamento do nosso próprio <script>
  assert.ok(html.includes(`<link rel="icon" type="image/png" href="${ICON}" />`));
  // os marcadores continuam no HTML gerado: a logo pode ser trocada de novo no mesmo lugar
  const again = renderPlayerHtml(def, { ...DEFAULT_BRAND, wordA: "Nova" });
  assert.ok(again.includes("<span class=\"wm\">Nova<b>APOSTA</b></span>") && !again.includes("casa<b>"));
});

test("link do suporte: só http(s); qualquer outra coisa vira vazio (sem botão)", () => {
  assert.equal(parseBrand(JSON.stringify({ supportUrl: "https://wa.me/5511999999999" })).supportUrl, "https://wa.me/5511999999999");
  assert.equal(parseBrand(JSON.stringify({ supportUrl: "javascript:alert(1)" })).supportUrl, "");
  assert.equal(mergeBrand(DEFAULT_BRAND, { supportUrl: "  https://t.me/casa  " }).supportUrl, "https://t.me/casa");
  assert.equal(mergeBrand(DEFAULT_BRAND, { supportUrl: 'https://x.com/"><script>' }).supportUrl, "");
  assert.equal(brandSchema.safeParse({ supportUrl: "wa.me/55" }).success, false);
  assert.equal(brandSchema.safeParse({ supportUrl: "" }).success, true);
});

test("brandSchema: só aceita imagem do /uploads/ e altura entre 18 e 64", () => {
  assert.equal(brandSchema.safeParse({ logoUrl: "https://x.com/a.png" }).success, false);
  assert.equal(brandSchema.safeParse({ logoUrl: null, iconUrl: ICON }).success, true);
  assert.equal(brandSchema.safeParse({ logoHeight: 80 }).success, false);
  assert.equal(brandSchema.safeParse({ name: "" }).success, false);
  assert.equal(brandSchema.safeParse({}).success, false);
});

test("renderBrandImage: logo perde a borda vazia e fica com até 192 px; ícone vira 256×256; SVG vira PNG", async () => {
  // 800×400 transparente com um retângulo de 400×100 no meio → corta a borda → 400×100 (não amplia)
  const rect = await sharp({ create: { width: 400, height: 100, channels: 4, background: { r: 229, g: 23, b: 63, alpha: 1 } } }).png().toBuffer();
  const padded = await sharp({ create: { width: 800, height: 400, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: rect, left: 200, top: 150 }]).png().toBuffer();
  const logo = await sharp(await renderBrandImage(padded, "logo")).metadata();
  assert.deepEqual([logo.format, logo.width, logo.height], ["png", 400, 100]);

  const big = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: "#123456" } }).jpeg().toBuffer();
  const bigOut = await sharp(await renderBrandImage(big, "logo")).metadata();
  assert.deepEqual([bigOut.width, bigOut.height], [384, 192]);

  const icon = await sharp(await renderBrandImage(big, "icon")).metadata();
  assert.deepEqual([icon.format, icon.width, icon.height], ["png", 256, 256]);

  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" fill="#e5173f"/><script>alert(1)</script></svg>');
  const fromSvg = await sharp(await renderBrandImage(svg, "logo", true)).metadata();
  assert.equal(fromSvg.format, "png");
  assert.equal(Math.round((fromSvg.width ?? 0) / (fromSvg.height ?? 1)), 3);
});

test("processBrandImage: recusa o que não é imagem antes de gravar qualquer arquivo", async () => {
  await assert.rejects(processBrandImage("data:text/plain;base64,AAAA", "logo"), /Envie uma imagem/);
  const junk = `data:image/png;base64,${Buffer.from("isso não é uma imagem").toString("base64")}`;
  await assert.rejects(processBrandImage(junk, "icon"), /Não deu para ler/);
});
