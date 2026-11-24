import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";
import { guardPlay } from "./protection.js";
import { playfiversKey } from "../casino/adapters/playfivers.js";
import { playableBalance, settleRoundTx, refundBonusTx, expireIfDue } from "./incentives.js";

/**
 * Carteira dos jogos (seamless, PlayFivers). A PlayFivers identifica o jogador pelo `user_code`
 * (= id do usuário no nosso sistema), não por uma sessão. Aqui aplicamos aposta/ganho/estorno
 * direto na carteira, com idempotência pelo `txn_id`.
 */

const INTEGRATION = "playfivers";
// SQLite guarda Decimal como REAL e acumula ruído (ex.: 3162.4999999999995) — devolve em centavos.
const cents = (d: number) => Math.round(Number(d) * 100) / 100;
const isUnique = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

const betExtId = (txnId: string) => `${INTEGRATION}:${txnId}:bet`;
const winExtId = (txnId: string) => `${INTEGRATION}:${txnId}:win`;
const refundExtId = (txnId: string, leg: "bet" | "win" | "bonus-bet" | "bonus-win") => `${INTEGRATION}:refund:${txnId}:${leg}`;
const bonusExtId = (txnId: string, leg: "bet" | "win") => `${INTEGRATION}:${txnId}:bonus-${leg}`;

async function walletOf(userCode: string) {
  const user = await prisma.user.findUnique({ where: { id: userCode }, include: { wallet: true } });
  if (!user || !user.wallet) throw new AppError("Usuário não encontrado", 404, "USER_NOT_FOUND");
  return { user, wallet: user.wallet };
}

/**
 * Jogo da rodada, para o GGR por jogo/provedor. A chave é "<provedor>:<código>"; quando o webhook
 * não traz o provedor e o código existe em mais de um (ex.: versão clone e OFICIAL), vale o que
 * este jogador abriu por último (cada abertura fica registrada em CasinoSession).
 */
async function gameIdFor(userId: string, gameCode?: string, providerCode?: string): Promise<string | null> {
  if (!gameCode) return null;
  if (providerCode) {
    const exact = await prisma.game.findUnique({
      where: { integration_externalId: { integration: INTEGRATION, externalId: playfiversKey(providerCode, gameCode) } },
      select: { id: true },
    });
    if (exact) return exact.id;
  }
  const suffix = `:${gameCode}`;
  const candidates = (await prisma.game.findMany({
    where: { integration: INTEGRATION, externalId: { endsWith: suffix } },
    select: { id: true, externalId: true },
  })).filter((g) => g.externalId?.endsWith(suffix)); // confere de novo: _ e % viram curinga no LIKE
  if (candidates.length <= 1) return candidates[0]?.id ?? null;
  const last = await prisma.casinoSession.findFirst({
    where: { userId, gameId: { in: candidates.map((c) => c.id) } },
    orderBy: { startedAt: "desc" },
    select: { gameId: true },
  });
  return last?.gameId ?? candidates[0].id;
}

/** Saldo do jogador para o jogo (webhook de saldo): real + bônus quando o último jogo aberto é da campanha ativa. */
export async function pfBalance(userCode: string): Promise<number> {
  const { user } = await walletOf(userCode);
  return playableBalance(user.id);
}

/**
 * Aposta + ganho de uma rodada (webhook WinBet, txn_type debit_credit). Debita a aposta (só se houver saldo) e
 * credita o prêmio numa única transação; idempotente pelo `txn_id`. Com incentivo ativo, nos jogos da campanha o
 * bônus cobre o que o saldo real não cobrir e a aposta soma ao rollover (services/incentives.ts).
 */
export async function pfWinBet(p: {
  userCode: string;
  txnId: string;
  roundId?: string;
  bet: number;
  win: number;
  gameCode?: string;
  providerCode?: string;
}): Promise<{ balance: number; duplicate: boolean }> {
  const { user, wallet } = await walletOf(p.userCode);
  if (!user.isActive) throw new AppError("Jogador bloqueado", 403, "PLAYER_BLOCKED");

  const ext = { bet: betExtId(p.txnId), win: winExtId(p.txnId), bonusBet: bonusExtId(p.txnId, "bet"), bonusWin: bonusExtId(p.txnId, "win") };
  const gameId = await gameIdFor(user.id, p.gameCode, p.providerCode);
  const already =
    (await prisma.walletTransaction.findFirst({ where: { externalId: { in: [ext.bet, ext.win] } }, select: { id: true } })) ??
    (await prisma.bonusTransaction.findFirst({ where: { externalId: { in: [ext.bonusBet, ext.bonusWin] } }, select: { id: true } }));
  if (already) return { balance: await playableBalance(user.id, gameId), duplicate: true };

  const bet = Math.max(0, cents(p.bet || 0));
  const win = Math.max(0, cents(p.win || 0));
  if (bet > 0) await guardPlay(user.id, bet); // autoexclusão/suspensão e limites
  await expireIfDue(user.id); // incentivo vencido encerra antes da rodada (o bônus que sobrou não paga mais nada)

  try {
    const balance = await prisma.$transaction((tx) =>
      settleRoundTx(tx, { userId: user.id, walletId: wallet.id, gameId, bet, win, roundId: p.roundId, reference: `playfivers:${p.txnId}`, ext }),
    );
    return { balance, duplicate: false };
  } catch (e) {
    if (isUnique(e)) return { balance: await playableBalance(user.id, gameId), duplicate: true };
    throw e;
  }
}

/**
 * Estorno de uma rodada (webhook Refund): devolve a aposta e retira o prêmio da rodada identificada pelo
 * `txn_id` — a parte em dinheiro real e a parte do bônus. Faz efeito uma vez só (idempotente).
 */
export async function pfRefund(p: {
  userCode: string;
  txnId: string;
}): Promise<{ balance: number; duplicate: boolean }> {
  const { user, wallet } = await walletOf(p.userCode);
  const ids = {
    bet: refundExtId(p.txnId, "bet"), win: refundExtId(p.txnId, "win"),
    bonusBet: refundExtId(p.txnId, "bonus-bet"), bonusWin: refundExtId(p.txnId, "bonus-win"),
  };

  const refunded =
    (await prisma.walletTransaction.findFirst({ where: { externalId: { in: [ids.bet, ids.win] } }, select: { id: true } })) ??
    (await prisma.bonusTransaction.findFirst({ where: { externalId: { in: [ids.bonusBet, ids.bonusWin] } }, select: { id: true } }));
  if (refunded) return { balance: await playableBalance(user.id), duplicate: true };

  const [origBet, origWin, bonusBet, bonusWin] = await Promise.all([
    prisma.walletTransaction.findUnique({ where: { externalId: betExtId(p.txnId) } }),
    prisma.walletTransaction.findUnique({ where: { externalId: winExtId(p.txnId) } }),
    prisma.bonusTransaction.findUnique({ where: { externalId: bonusExtId(p.txnId, "bet") } }),
    prisma.bonusTransaction.findUnique({ where: { externalId: bonusExtId(p.txnId, "win") } }),
  ]);
  if (!origBet && !origWin && !bonusBet && !bonusWin) return { balance: await playableBalance(user.id), duplicate: false }; // nada a estornar
  const gameId = origBet?.gameId ?? origWin?.gameId ?? bonusBet?.gameId ?? bonusWin?.gameId ?? null;

  try {
    await prisma.$transaction(async (tx) => {
      if (origBet) {
        const back = origBet.amount.negated(); // aposta foi gravada negativa → credita de volta
        const after = (await tx.wallet.update({ where: { id: wallet.id }, data: { balance: { increment: back } } })).balance;
        await tx.walletTransaction.create({
          data: {
            walletId: wallet.id, type: "CASINO_REFUND", amount: back, balanceAfter: after,
            gameId: origBet.gameId, roundId: origBet.roundId, externalId: ids.bet,
            reference: `playfivers:refund:${p.txnId}`,
          },
        });
      }
      if (origWin) {
        const take = origWin.amount.negated(); // prêmio foi positivo → debita de volta
        const after = (await tx.wallet.update({ where: { id: wallet.id }, data: { balance: { increment: take } } })).balance;
        await tx.walletTransaction.create({
          data: {
            walletId: wallet.id, type: "CASINO_REFUND", amount: take, balanceAfter: after,
            gameId: origWin.gameId, roundId: origWin.roundId, externalId: ids.win,
            reference: `playfivers:refund:${p.txnId}`,
          },
        });
      }
      await refundBonusTx(tx, { bet: bonusBet, win: bonusWin, ext: { bet: ids.bonusBet, win: ids.bonusWin } });
    });
    return { balance: await playableBalance(user.id, gameId), duplicate: false };
  } catch (e) {
    if (isUnique(e)) return { balance: await playableBalance(user.id), duplicate: true };
    throw e;
  }
}

/* ───────────── segurança dos webhooks (puras, testáveis) ───────────── */

/** IP de origem permitido. Lista vazia = não bloqueia (dev); localhost sempre passa. */
export function ipAllowed(ip: string, allowlistCsv: string | undefined): boolean {
  const list = (allowlistCsv ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) return true;
  if (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1") return true;
  return list.includes(ip);
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export type AgentCheck =
  | { ok: true }
  | { ok: false; reason: "no_secret_configured" | "secret_mismatch" | "agent_code_mismatch" };

/**
 * Autentica o callback de transação (que mexe na carteira). Sem segredo configurado RECUSA — antes da
 * instalação não existe tráfego legítimo, e aceitar seria deixar qualquer um creditar saldo.
 * Confere o agent_secret (= "Segredo do agente") e, se configurado, o agent_code ("Código do agente",
 * que pela doc da PlayFivers é diferente do token). Devolve o motivo da recusa para o log do operador.
 */
export function agentCheck(
  body: { agent_code?: unknown; agent_secret?: unknown },
  agentCode: string | undefined,
  secret: string | undefined,
): AgentCheck {
  if (!secret) return { ok: false, reason: "no_secret_configured" };
  if (typeof body.agent_secret !== "string" || !safeEqual(body.agent_secret, secret)) return { ok: false, reason: "secret_mismatch" };
  if (agentCode && body.agent_code !== agentCode) return { ok: false, reason: "agent_code_mismatch" };
  return { ok: true };
}

export function agentOk(
  body: { agent_code?: unknown; agent_secret?: unknown },
  agentCode: string | undefined,
  secret: string | undefined,
): boolean {
  return agentCheck(body, agentCode, secret).ok;
}

export type PfCallbackKind = "balance" | "txn";

/**
 * Qual handler atende um callback da PlayFivers. Ela manda TODOS os eventos para a mesma "Callback URL"
 * do agente (sem acrescentar caminho); quem separa é o campo `type`: BALANCE → saldo; WinBet/Refund → transação.
 */
export function callbackKind(body: unknown): PfCallbackKind | null {
  const raw = body && typeof body === "object" ? (body as { type?: unknown }).type : undefined;
  const t = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (t === "balance") return "balance";
  if (t === "winbet" || t === "refund") return "txn";
  return null;
}

/**
 * Erro → resposta no formato que a doc da PlayFivers espera ({ msg, balance }), com os códigos
 * INVALID_USER (404), INSUFFICIENT_USER_FUNDS (400) e ERROR_INTERNAL (500).
 */
export function pfErrorBody(e: unknown): { status: number; msg: string } {
  if (e instanceof AppError) {
    if (e.code === "USER_NOT_FOUND") return { status: 404, msg: "INVALID_USER" };
    if (e.code === "INSUFFICIENT_FUNDS") return { status: 400, msg: "INSUFFICIENT_USER_FUNDS" };
    if (e.status < 500) return { status: e.status, msg: e.code ?? e.message };
  }
  return { status: 500, msg: "ERROR_INTERNAL" };
}
