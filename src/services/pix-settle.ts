import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";
import type { PixGateway } from "../payments/types.js";
import { applyDepositIncentive } from "./incentives.js";

/**
 * Liquidação dos pedidos PIX — usada pelos avisos (webhooks) dos gateways e pela aprovação manual no
 * admin. Toda troca de status é "reivindicada" com updateMany(where status = X): aviso repetido ou duas
 * aprovações ao mesmo tempo nunca creditam nem debitam duas vezes.
 */

/**
 * Credita um depósito pago. false = a ordem já não estava pendente (aviso repetido).
 * Se o jogador escolheu uma campanha de incentivo, o bônus entra logo depois, em transação própria
 * (uma falha no bônus nunca desfaz o depósito; o motivo fica anotado na ordem).
 */
export async function settleDeposit(
  orderId: string,
  opts: { txid?: string; fee?: number; amount?: number; adminId?: string } = {},
): Promise<boolean> {
  const ok = await creditDeposit(orderId, opts);
  if (ok) await applyDepositIncentive(orderId).catch((e) => console.warn("incentivo do depósito não aplicado", orderId, e));
  return ok;
}

async function creditDeposit(orderId: string, opts: { txid?: string; fee?: number; amount?: number; adminId?: string }): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const order = await tx.pixOrder.findUnique({ where: { id: orderId } });
    if (!order || order.kind !== "DEPOSIT") throw new AppError("Ordem não encontrada", 404, "NOT_FOUND");
    // Valor pago diferente do pedido não credita: fica para a equipe conferir.
    if (opts.amount !== undefined && Math.abs(Number(order.amount) - opts.amount) > 0.009) {
      throw new AppError(
        `Valor pago (R$ ${opts.amount.toFixed(2)}) diferente do pedido (R$ ${Number(order.amount).toFixed(2)}) — não creditado`,
        409,
        "AMOUNT_MISMATCH",
      );
    }
    const claimed = await tx.pixOrder.updateMany({
      where: { id: orderId, status: "PENDING" },
      data: {
        status: "PAID",
        paidAt: new Date(),
        ...(opts.txid ? { txid: opts.txid } : {}),
        ...(opts.fee !== undefined ? { fee: new Decimal(opts.fee) } : {}),
      },
    });
    if (claimed.count !== 1) return false;
    const wallet = await tx.wallet.findUnique({ where: { userId: order.userId } });
    if (!wallet) throw new AppError("Carteira inexistente", 404);
    const updated = await tx.wallet.update({ where: { id: wallet.id }, data: { balance: { increment: order.amount } } });
    await tx.walletTransaction.create({
      data: { walletId: wallet.id, type: "DEPOSIT", amount: order.amount, balanceAfter: updated.balance, reference: orderId },
    });
    if (opts.adminId) await tx.adminAuditLog.create({ data: { adminId: opts.adminId, action: "PIX_APPROVE", target: orderId } });
    return true;
  });
}

/** Depósito que expirou sem pagamento. */
export async function expireDeposit(orderId: string): Promise<boolean> {
  const r = await prisma.pixOrder.updateMany({ where: { id: orderId, kind: "DEPOSIT", status: "PENDING" }, data: { status: "EXPIRED" } });
  return r.count === 1;
}

/**
 * Aprova um saque. Sem gateway: debita e marca PAID (modo manual). Com gateway: debita, marca
 * PROCESSING e envia o payout; se o gateway recusar na hora, o saldo volta e a ordem retorna a PENDING
 * (a equipe pode tentar de novo ou recusar).
 */
export async function approveWithdraw(
  orderId: string,
  adminId: string,
  gateway: PixGateway | null,
  ctx: { postbackUrl?: string; payeeName?: string } = {},
): Promise<{ status: "PAID" | "PROCESSING" }> {
  const order = await prisma.$transaction(async (tx) => {
    const o = await tx.pixOrder.findUnique({ where: { id: orderId } });
    if (!o || o.kind !== "WITHDRAW") throw new AppError("Ordem não encontrada", 404, "NOT_FOUND");
    const claimed = await tx.pixOrder.updateMany({
      where: { id: orderId, status: "PENDING" },
      data: gateway
        ? { status: "PROCESSING", gateway: gateway.key, note: null }
        : { status: "PAID", paidAt: new Date(), txid: `MOCK-${Date.now()}-${orderId.slice(-8)}` },
    });
    if (claimed.count !== 1) throw new AppError("Ordem já processada", 400);
    const wallet = await tx.wallet.findUnique({ where: { userId: o.userId } });
    if (!wallet) throw new AppError("Carteira inexistente", 404);
    if (wallet.balance.lessThan(o.amount)) throw new AppError("Saldo insuficiente no saque", 400);
    const updated = await tx.wallet.update({ where: { id: wallet.id }, data: { balance: { decrement: o.amount } } });
    await tx.walletTransaction.create({
      data: { walletId: wallet.id, type: "WITHDRAW", amount: new Decimal(0).sub(o.amount), balanceAfter: updated.balance, reference: orderId },
    });
    await tx.adminAuditLog.create({
      data: { adminId, action: "PIX_APPROVE", target: orderId, payload: JSON.stringify({ gateway: gateway?.key ?? "LAB" }) },
    });
    return o;
  });
  if (!gateway) return { status: "PAID" };

  try {
    const r = await gateway.createPayout({
      orderId,
      amount: Number(order.amount),
      pixKey: order.pixKey ?? "",
      pixKeyType: order.pixKeyType ?? "",
      name: ctx.payeeName,
      postbackUrl: ctx.postbackUrl,
    });
    await prisma.pixOrder.update({ where: { id: orderId }, data: { txid: `${gateway.key}:${r.gatewayTxId}` } });
    return { status: "PROCESSING" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "erro desconhecido";
    await refundWithdraw(orderId, ["PROCESSING"], "PENDING", `${gateway.name} recusou: ${msg}`);
    throw new AppError(`${gateway.name} recusou o saque: ${msg}`, 502, "PAYOUT_REJECTED");
  }
}

/** Devolve o saldo de um saque que não foi pago e move a ordem para `to`. */
async function refundWithdraw(orderId: string, from: ("PROCESSING" | "PAID")[], to: "PENDING" | "FAILED", note: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const o = await tx.pixOrder.findUnique({ where: { id: orderId } });
    if (!o || o.kind !== "WITHDRAW") return false;
    const claimed = await tx.pixOrder.updateMany({
      where: { id: orderId, status: { in: from } },
      data: { status: to, note: note.slice(0, 300), ...(to === "PENDING" ? { txid: null } : {}) },
    });
    if (claimed.count !== 1) return false;
    const wallet = await tx.wallet.findUnique({ where: { userId: o.userId } });
    if (!wallet) throw new AppError("Carteira inexistente", 404);
    const updated = await tx.wallet.update({ where: { id: wallet.id }, data: { balance: { increment: o.amount } } });
    await tx.walletTransaction.create({
      data: { walletId: wallet.id, type: "WITHDRAW", amount: o.amount, balanceAfter: updated.balance, reference: `${orderId}:estorno` },
    });
    return true;
  });
}

/** Payout confirmado pelo gateway. */
export async function settlePayout(orderId: string, opts: { fee?: number } = {}): Promise<boolean> {
  const r = await prisma.pixOrder.updateMany({
    where: { id: orderId, kind: "WITHDRAW", status: "PROCESSING" },
    data: { status: "PAID", paidAt: new Date(), ...(opts.fee !== undefined ? { fee: new Decimal(opts.fee) } : {}) },
  });
  return r.count === 1;
}

/** Payout recusado ou estornado pelo gateway: a ordem falha e o saldo volta para o jogador. */
export const failPayout = (orderId: string, reason: string) => refundWithdraw(orderId, ["PROCESSING", "PAID"], "FAILED", reason);
