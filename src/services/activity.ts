import { prisma } from "../lib/prisma.js";

/**
 * Acessos do jogador, base do "Usuários ativos" do dashboard.
 * O guia do Axio aponta que contar só LOGIN zera o indicador quando o jogador já estava com a
 * sessão aberta (os tokens daqui não expiram). Por isso também registramos a sessão em uso —
 * no máximo 1 registro a cada 15 min por jogador, para não gravar a cada requisição.
 */

export const SESSION_EVERY_MS = 15 * 60 * 1000;
const lastSeen = new Map<string, number>();

/** Pura: a sessão só é registrada de novo depois do intervalo mínimo. */
export function shouldRecordSession(last: number | undefined, now: number): boolean {
  return last === undefined || now - last >= SESSION_EVERY_MS;
}

/** Registra o acesso sem bloquear a requisição (falha de escrita não derruba a rota). */
export function recordActivity(
  userId: string,
  kind: "login" | "register" | "session",
  meta: { ip?: string; userAgent?: string } = {},
  now = Date.now(),
) {
  if (kind === "session" && !shouldRecordSession(lastSeen.get(userId), now)) return;
  if (lastSeen.size > 50_000) lastSeen.clear();
  lastSeen.set(userId, now);
  const userAgent = meta.userAgent ? meta.userAgent.slice(0, 300) : null;
  prisma.userActivity.create({ data: { userId, kind, ip: meta.ip ?? null, userAgent } }).catch(() => {});
}
