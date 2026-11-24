import { AppError } from "../lib/errors.js";
import { dayKey } from "./reports.js";

/** Utilidades das telas de Operação (datas no fuso de São Paulo, paginação, nomes). */

const OFFSET = "-03:00";
export const addDays = (ymd: string, n: number) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Intervalo de dias inteiros (fim exclusivo à meia-noite do dia seguinte). Padrão: últimos 30 dias. */
export function opsRange(from?: string, to?: string, defDays = 30) {
  const t = to ?? dayKey(new Date());
  const f = from ?? addDays(t, -(defDays - 1));
  if (f > t) throw new AppError("A data inicial deve ser antes da final", 400, "BAD_PERIOD");
  const start = new Date(`${f}T00:00:00${OFFSET}`);
  const end = new Date(`${addDays(t, 1)}T00:00:00${OFFSET}`);
  if (end.getTime() - start.getTime() > 366 * 86_400_000) throw new AppError("Período máximo de 1 ano", 400, "BAD_PERIOD");
  return { from: f, to: t, start, end };
}

export function dayList(from: string, to: string) {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 400; d = addDays(d, 1)) out.push(d);
  return out;
}

export const cents = (v: unknown) => Math.round(Number(v ?? 0) * 100);
export const r2 = (n: number) => Math.round(n * 100) / 100;
export const pageArgs = (page: number, size: number) => ({ skip: (page - 1) * size, take: size });
export const userName = (u: { displayName: string | null; email: string }) => u.displayName?.trim() || u.email.split("@")[0];
export const isLocalIp = (ip: string | null | undefined) => !ip || ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";

/** Restrição valendo agora, no formato de filtro do Prisma. */
export const activeRestrictionWhere = (now = new Date()) => ({
  revokedAt: null,
  startsAt: { lte: now },
  OR: [{ endsAt: null }, { endsAt: { gt: now } }],
});
