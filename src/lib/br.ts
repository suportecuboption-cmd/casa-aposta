/**
 * Helpers de identificadores brasileiros (CPF e celular) usados no cadastro.
 * Validação é feita sobre a string crua; o valor é guardado só com dígitos.
 */

/** Remove tudo que não for dígito. */
export function normalizeCpf(v: string): string {
  return (v || "").replace(/\D/g, "");
}

/** Valida CPF pelos dois dígitos verificadores (rejeita sequências repetidas). */
export function isValidCpf(v: string): boolean {
  const c = normalizeCpf(v);
  if (c.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(c)) return false; // 000.000.000-00, 111..., etc.
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(c[i]) * (10 - i);
  let d1 = 11 - (sum % 11);
  if (d1 >= 10) d1 = 0;
  if (d1 !== Number(c[9])) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += Number(c[i]) * (11 - i);
  let d2 = 11 - (sum % 11);
  if (d2 >= 10) d2 = 0;
  return d2 === Number(c[10]);
}

/** Celular nacional (DDD + número), sem o +55. Remove o 55 se vier colado. */
export function normalizePhone(v: string): string {
  let d = (v || "").replace(/\D/g, "");
  if (d.length > 11 && d.startsWith("55")) d = d.slice(2);
  return d;
}

/** Celular brasileiro com DDD válido (11–99); 11 dígitos exige o 9 inicial do celular. */
export function isValidPhoneBR(v: string): boolean {
  const d = normalizePhone(v);
  if (!/^\d{10,11}$/.test(d)) return false;
  const ddd = Number(d.slice(0, 2));
  if (ddd < 11 || ddd > 99) return false;
  if (d.length === 11 && d[2] !== "9") return false;
  return true;
}
