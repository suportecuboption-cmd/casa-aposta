import type { Prisma } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";
import { loadProtection } from "./protection.js";

/**
 * Base da fidelidade (Nível VIP e Coleções): o quanto o jogador já apostou e o crédito dos prêmios.
 * Prêmio entra na carteira como lançamento BONUS — os relatórios e a ficha do jogador já o contam como bônus.
 */

const WAGER_TYPES = ["CASINO_BET", "BET_STAKE", "CASINO_REFUND", "BET_REFUND"] as const;
const r2 = (v: number) => Math.round(v * 100) / 100;

/** Pura: total apostado = apostas − estornos (no extrato a aposta vem negativa e o estorno positivo). */
export function wageredFrom(groups: { type: string; sum: number }[]): number {
  const sum = (types: string[]) => groups.filter((g) => types.includes(g.type)).reduce((s, g) => s + g.sum, 0);
  const staked = -sum(["CASINO_BET", "BET_STAKE"]);
  const refunded = sum(["CASINO_REFUND", "BET_REFUND"]);
  return r2(Math.max(0, staked - refunded));
}

export async function wageredTotal(userId: string): Promise<number> {
  const wallet = await prisma.wallet.findUnique({ where: { userId }, select: { id: true } });
  if (!wallet) return 0;
  const groups = await prisma.walletTransaction.groupBy({
    by: ["type"],
    where: { walletId: wallet.id, type: { in: [...WAGER_TYPES] } },
    _sum: { amount: true },
  });
  return wageredFrom(groups.map((g) => ({ type: g.type, sum: Number(g._sum.amount ?? 0) })));
}

/** Conta bloqueada ou em autoexclusão não recebe prêmio nem abre pacote. */
export async function assertCanReceiveRewards(userId: string) {
  const { mode } = await loadProtection(userId);
  if (mode !== "OPERATIONAL") {
    throw new AppError("Sua conta não pode receber prêmios agora. Veja os detalhes em Jogo responsável.", 403, "PLAYER_RESTRICTED");
  }
}

/** Credita um prêmio (BONUS) dentro de uma transação já aberta; devolve o saldo novo. */
export async function creditBonus(tx: Prisma.TransactionClient, userId: string, amount: number, reference: string, meta: Record<string, unknown>) {
  const wallet = await tx.wallet.findUnique({ where: { userId }, select: { id: true } });
  if (!wallet) throw new AppError("Carteira inexistente", 404, "NOT_FOUND");
  const value = new Decimal(amount).toDecimalPlaces(2);
  const w = await tx.wallet.update({ where: { id: wallet.id }, data: { balance: { increment: value } } });
  await tx.walletTransaction.create({
    data: { walletId: wallet.id, type: "BONUS", amount: value, balanceAfter: w.balance, reference, meta: JSON.stringify(meta) },
  });
  return Number(w.balance);
}

/** Pura: erro de chave única do Prisma (o resgate já existe). */
export const isUniqueViolation = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";
