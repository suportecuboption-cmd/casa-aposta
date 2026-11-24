import type { FastifyInstance } from "fastify";
import { Decimal } from "@prisma/client/runtime/library";
import QRCode from "qrcode";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";
import { depositSchema, withdrawSchema, idParamSchema } from "../schemas/index.js";
import { guardDeposit, guardWithdraw } from "../services/protection.js";
import { activeGateway, webhookUrlFor, payerOf } from "../payments/registry.js";
import { assertNoActiveIncentive, checkDepositCampaign } from "../services/incentives.js";

/** QR do código "copia e cola" como imagem (data URL); null se não der para gerar. */
const pixQr = (code: string | null | undefined) =>
  code ? QRCode.toDataURL(code, { margin: 1, width: 240, errorCorrectionLevel: "M" }).catch(() => null) : Promise.resolve(null);

export async function walletRoutes(app: FastifyInstance) {
  app.get("/wallet", async (req) => {
    const jwt = await app.authenticate(req);
    const wallet = await prisma.wallet.findUnique({ where: { userId: jwt.sub } });
    if (!wallet) throw new AppError("Carteira inexistente", 404);
    return wallet;
  });

  app.get("/wallet/transactions", async (req) => {
    const jwt = await app.authenticate(req);
    const wallet = await prisma.wallet.findUnique({ where: { userId: jwt.sub } });
    if (!wallet) throw new AppError("Carteira inexistente", 404);
    const txs = await prisma.walletTransaction.findMany({
      where: { walletId: wallet.id },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return txs;
  });

  // Depósito PIX. Com gateway ativo (Admin → Pagamentos → Gateways) gera o PIX real nele e o saldo
  // entra sozinho pelo aviso do gateway; sem gateway, modo manual: PIX simulado e a equipe aprova.
  app.post("/wallet/deposit/pix", async (req) => {
    const jwt = await app.authenticate(req);
    const { amount, campaignId } = depositSchema.parse(req.body);
    await guardDeposit(jwt.sub, amount); // autoexclusão/suspensão e limite de depósito
    const bonus = campaignId ? (await checkDepositCampaign(jwt.sub, campaignId, amount)).bonus : 0; // a campanha vale agora?
    const gw = activeGateway();
    if (!gw) {
      const order = await prisma.pixOrder.create({
        data: {
          userId: jwt.sub,
          kind: "DEPOSIT",
          amount: new Decimal(amount),
          campaignId: campaignId ?? null,
          pixCopy: `00020126580014br.gov.bcb.pix0136LAB-${Date.now()}5204000053039865802BR5910CASA_APOST6009SAO_PAULO62070503***6304ABCD`,
        },
      });
      return { orderId: order.id, status: order.status, pixCopy: order.pixCopy, amount, bonus, gateway: "LAB", qr: await pixQr(order.pixCopy) };
    }
    const user = await prisma.user.findUnique({ where: { id: jwt.sub }, select: { email: true, displayName: true, cpf: true } });
    if (!user) throw new AppError("Conta não encontrada", 404);
    const order = await prisma.pixOrder.create({ data: { userId: jwt.sub, kind: "DEPOSIT", amount: new Decimal(amount), gateway: gw.key, campaignId: campaignId ?? null } });
    try {
      const r = await gw.createDeposit({ orderId: order.id, amount, payer: payerOf(user), postbackUrl: webhookUrlFor(gw.key) || undefined });
      await prisma.pixOrder.update({
        where: { id: order.id },
        data: { txid: `${gw.key}:${r.gatewayTxId}`, pixCopy: r.pixCopy, ...(r.fee !== undefined ? { fee: new Decimal(r.fee) } : {}) },
      });
      return { orderId: order.id, status: "PENDING", pixCopy: r.pixCopy, amount, bonus, gateway: gw.key, expiresAt: r.expiresAt ?? null, qr: await pixQr(r.pixCopy) };
    } catch (e) {
      // O jogador vê uma mensagem genérica; o motivo real fica no log e na ordem (admin).
      const reason = e instanceof Error ? e.message : String(e);
      req.log.warn({ gateway: gw.key, orderId: order.id, reason }, "depósito: o gateway recusou");
      await prisma.pixOrder.update({ where: { id: order.id }, data: { status: "FAILED", note: `${gw.name}: ${reason}`.slice(0, 300) } });
      throw new AppError("PIX indisponível no momento. Tente de novo em instantes.", 503, "PAYMENT_UNAVAILABLE");
    }
  });

  // Situação de um depósito — a tela do PIX consulta até o pagamento cair.
  app.get("/wallet/deposit/pix/:id", async (req) => {
    const jwt = await app.authenticate(req);
    const { id } = idParamSchema.parse(req.params);
    const o = await prisma.pixOrder.findFirst({
      where: { id, userId: jwt.sub, kind: "DEPOSIT" },
      select: { id: true, status: true, amount: true, paidAt: true },
    });
    if (!o) throw new AppError("Depósito não encontrado", 404, "NOT_FOUND");
    return o;
  });

  app.post("/wallet/withdraw/pix", async (req) => {
    const jwt = await app.authenticate(req);
    const { amount, pixKey, pixKeyType } = withdrawSchema.parse(req.body);
    const wallet = await prisma.wallet.findUnique({ where: { userId: jwt.sub }, include: { user: { select: { cpf: true } } } });
    if (!wallet) throw new AppError("Carteira inexistente", 404);
    if (wallet.balance.lessThan(amount)) {
      throw new AppError("Saldo insuficiente", 400, "INSUFFICIENT_FUNDS");
    }
    await assertNoActiveIncentive(jwt.sub); // incentivo com rollover em andamento segura o saque
    await guardWithdraw(jwt.sub, amount); // conta bloqueada e limites de saque
    const order = await prisma.pixOrder.create({
      data: {
        userId: jwt.sub,
        kind: "WITHDRAW",
        amount: new Decimal(amount),
        status: "PENDING",
        pixKey: pixKey ?? wallet.user.cpf ?? null,
        pixKeyType: pixKey ? (pixKeyType ?? null) : wallet.user.cpf ? "CPF" : null,
      },
    });
    return { orderId: order.id, status: order.status, amount };
  });
}
