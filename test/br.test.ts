import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidCpf, normalizeCpf, isValidPhoneBR, normalizePhone } from "../src/lib/br.js";

/* ── CPF ── */

// Gera um CPF válido (mesma lógica do cadastro) para o teste de ida-e-volta.
function genCpf(seed: number[]): string {
  const n = seed.slice(0, 9);
  let s = 0;
  for (let i = 0; i < 9; i++) s += n[i] * (10 - i);
  let d1 = 11 - (s % 11); if (d1 >= 10) d1 = 0; n.push(d1);
  s = 0;
  for (let i = 0; i < 10; i++) s += n[i] * (11 - i);
  let d2 = 11 - (s % 11); if (d2 >= 10) d2 = 0; n.push(d2);
  return n.join("");
}

test("CPF: aceita válidos, com ou sem máscara", () => {
  assert.equal(isValidCpf("52998224725"), true);
  assert.equal(isValidCpf("529.982.247-25"), true); // valida sobre a string crua
  assert.equal(isValidCpf("111.444.777-35"), true);
});

test("CPF: rejeita dígito verificador errado", () => {
  assert.equal(isValidCpf("52998224724"), false); // último dígito trocado
  assert.equal(isValidCpf("11144477734"), false);
});

test("CPF: rejeita sequências repetidas e tamanho errado", () => {
  for (const d of ["00000000000", "11111111111", "99999999999"]) assert.equal(isValidCpf(d), false);
  assert.equal(isValidCpf("123"), false);
  assert.equal(isValidCpf("5299822472"), false);  // 10 dígitos
  assert.equal(isValidCpf("529982247250"), false); // 12 dígitos
  assert.equal(isValidCpf(""), false);
});

test("CPF: ida-e-volta — gerados são válidos e cobrem o dígito 0", () => {
  // Inclui uma semente cujo DV cai no ramo >=10 → 0 (CPF válido terminando em 00).
  assert.equal(genCpf([1, 2, 3, 4, 5, 6, 7, 8, 9]), "12345678909");
  assert.equal(isValidCpf("12345678909"), true);
  let sawZeroDv = false;
  for (let k = 0; k < 400; k++) {
    const seed = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
    const cpf = genCpf(seed);
    if (/^(\d)\1{10}$/.test(cpf)) continue; // gerador pode cair numa repetida
    assert.equal(isValidCpf(cpf), true);
    // trocar o último dígito deve invalidar
    const wrong = cpf.slice(0, 10) + ((Number(cpf[10]) + 1) % 10);
    assert.equal(isValidCpf(wrong), false);
    if (cpf.endsWith("0")) sawZeroDv = true;
  }
  assert.equal(sawZeroDv, true);
});

test("normalizeCpf: deixa só dígitos", () => {
  assert.equal(normalizeCpf("529.982.247-25"), "52998224725");
  assert.equal(normalizeCpf("  111 444 777 35 "), "11144477735");
  assert.equal(normalizeCpf(""), "");
});

/* ── Celular ── */

test("celular: aceita BR válido, com ou sem máscara e com +55", () => {
  assert.equal(isValidPhoneBR("11987654321"), true);       // celular 11 dígitos
  assert.equal(isValidPhoneBR("(11) 98765-4321"), true);   // com máscara
  assert.equal(isValidPhoneBR("1133334444"), true);        // fixo 10 dígitos
  assert.equal(isValidPhoneBR("5511987654321"), true);     // +55 colado
  assert.equal(isValidPhoneBR("55987654321"), true);       // DDD 55 preservado
});

test("celular: rejeita DDD, tamanho e nono dígito inválidos", () => {
  assert.equal(isValidPhoneBR("119876543"), false);   // curto demais (9)
  assert.equal(isValidPhoneBR("119876543210"), false); // longo demais (12)
  assert.equal(isValidPhoneBR("0998765432"), false);  // DDD 09
  assert.equal(isValidPhoneBR("11887654321"), false); // 11 dígitos sem o 9
  assert.equal(isValidPhoneBR(""), false);
});

test("normalizePhone: tira máscara e remove o 55 do país quando sobra", () => {
  assert.equal(normalizePhone("+55 (11) 98765-4321"), "11987654321");
  assert.equal(normalizePhone("5511987654321"), "11987654321");
  assert.equal(normalizePhone("11987654321"), "11987654321"); // 11 dígitos: não mexe
  assert.equal(normalizePhone("55987654321"), "55987654321"); // DDD 55, 11 dígitos: mantém
  assert.equal(normalizePhone(""), "");
});
