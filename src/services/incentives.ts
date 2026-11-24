import type { Prisma, IncentiveCampaign, BonusTransaction } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";
import { providerDisplayName } from "../lib/provider-name.js";
import { loadProtection } from "./protection.js";
import { getWalletSettings } from "./casino-wallets.js";
import { isUniqueViolation } from "./loyalty.js";
import {
  type CampaignRules, type Trigger, type RolloverBase, type EligibilityCtx,
  r2, brl, depositBonus, rolloverTarget, splitStake, splitWin, rolloverContribution, rolloverReached,
  rolloverProgress, rolloverLeft, conversion, campaignWindow, expiresAtFrom, ineligibleReason,
} from "./incentive-rules.js";
import type { CampaignInput } from "../schemas/incentives.js";

/**
 * Incentivos (admin → Incentivos): campanhas de bônus com rollover nos jogos escolhidos.
 * O bônus fica em Wallet.bonus (um incentivo ativo por jogador) e o extrato dele em BonusTransaction;
 * o WalletTransaction continua só com dinheiro real (relatórios, GGR e limites seguem iguais).
 * Quando o rollover é cumprido, o bônus vira saldo real com um lançamento BONUS (custo do bônus nos relatórios).
 */

type Tx = Prisma.TransactionClient;
const num = (d: Decimal | number | null | undefined) => (d == null ? null : Number(d));
const n0 = (d: Decimal | number | null | undefined) => Number(d ?? 0);
const dec = (v: number) => new Decimal(r2(v)).toDecimalPlaces(2);
const cents = (v: Decimal | number) => r2(Number(v));

export function rulesOf(c: IncentiveCampaign): CampaignRules {
  return {
    trigger: c.trigger as Trigger, active: c.active, startsAt: c.startsAt, endsAt: c.endsAt,
    bonusPercent: num(c.bonusPercent), bonusFixed: num(c.bonusFixed), maxBonus: num(c.maxBonus), minDeposit: num(c.minDeposit),
    firstDepositOnly: c.firstDepositOnly, requireDeposit: c.requireDeposit,
    rolloverTimes: Number(c.rolloverTimes), rolloverBase: c.rolloverBase as RolloverBase,
    maxBet: num(c.maxBet), maxConversion: num(c.maxConversion), validDays: c.validDays, maxPerPlayer: c.maxPerPlayer,
  };
}

/* ───────────── jogos da campanha ───────────── */

const enabledWallets = async () => (await getWalletSettings()).enabled;
// "no site" = jogo ativo de uma carteira habilitada na PlayFivers (o mesmo filtro do /games)
const onSite = (enabled: string[]) => ({ isActive: true, provider: { wallet: { in: enabled } } });
const GAME_VIEW = { id: true, name: true, imageUrl: true, isActive: true, provider: { select: { name: true, wallet: true } } } as const;
type GameRow = { id: string; name: string; imageUrl: string | null; isActive: boolean; provider: { name: string; wallet: string | null } };
const gameView = (g: GameRow, enabled: string[]) => ({
  id: g.id, name: g.name, imageUrl: g.imageUrl, provider: providerDisplayName(g.provider.name),
  active: g.isActive && enabled.includes(g.provider.wallet ?? ""),
});

/** Jogos da campanha que aparecem no site: prévia (capas primeiro) e o total. */
async function siteGames(campaignId: string, enabled: string[], take: number) {
  const where = { campaignId, game: onSite(enabled) };
  const [rows, total] = await Promise.all([
    prisma.incentiveGame.findMany({ where, orderBy: { position: "asc" }, take: Math.max(take * 3, 60), select: { game: { select: GAME_VIEW } } }),
    prisma.incentiveGame.count({ where }),
  ]);
  const games = rows.map((r) => r.game).sort((a, b) => Number(!!b.imageUrl) - Number(!!a.imageUrl)).slice(0, take);
  return { games: games.map((g) => gameView(g, enabled)), total };
}

async function isCampaignGame(tx: Tx, campaignId: string, gameId: string | null) {
  if (!gameId) return false;
  const hit = await tx.incentiveGame.findUnique({ where: { campaignId_gameId: { campaignId, gameId } }, select: { gameId: true } });
  return !!hit;
}

/* ───────────── concessão, conversão e encerramento (dentro de transação) ───────────── */

async function grantTx(tx: Tx, p: {
  userId: string; campaign: IncentiveCampaign; bonus: number; deposit: number | null; now: Date;
  pixOrderId?: string; grantedBy?: string; note?: string;
}) {
  if (!(p.bonus > 0)) throw new AppError("O bônus precisa ser maior que zero.", 400, "VALIDATION");
  const rules = rulesOf(p.campaign);
  const target = rolloverTarget(rules, p.bonus, p.deposit ?? 0);
  const wallet = await tx.wallet.findUnique({ where: { userId: p.userId }, select: { id: true } });
  if (!wallet) throw new AppError("Carteira inexistente", 404, "NOT_FOUND");
  const inc = await tx.playerIncentive.create({
    data: {
      userId: p.userId, campaignId: p.campaign.id, status: "ACTIVE", activeKey: p.userId,
      bonusAmount: dec(p.bonus), depositAmount: p.deposit != null ? dec(p.deposit) : null, pixOrderId: p.pixOrderId ?? null,
      rolloverTarget: dec(target), maxBet: rules.maxBet != null ? dec(rules.maxBet) : null,
      maxConversion: rules.maxConversion != null ? dec(rules.maxConversion) : null,
      expiresAt: expiresAtFrom(p.now, rules.validDays), grantedBy: p.grantedBy ?? null, note: p.note || null,
    },
  });
  const w = await tx.wallet.update({ where: { id: wallet.id }, data: { bonus: { increment: dec(p.bonus) } } });
  await tx.bonusTransaction.create({ data: { incentiveId: inc.id, type: "GRANT", amount: dec(p.bonus), bonusAfter: w.bonus } });
  if (p.grantedBy) {
    await tx.adminAuditLog.create({
      data: { adminId: p.grantedBy, action: "INCENTIVE_GRANT", target: inc.id, payload: JSON.stringify({ userId: p.userId, campaign: p.campaign.name, bonus: r2(p.bonus), rolloverTarget: target }) },
    });
  }
  return inc;
}

/** Encerra sem converter (expirou, cancelado, bônus esgotado): o saldo de bônus que sobrou é retirado. */
async function endTx(tx: Tx, incentiveId: string, status: "EXPIRED" | "CANCELLED" | "LOST", by: string | null, note?: string) {
  const claimed = await tx.playerIncentive.updateMany({
    where: { id: incentiveId, status: "ACTIVE" },
    data: { status, activeKey: null, endedAt: new Date(), endedBy: by },
  });
  if (claimed.count !== 1) return null;
  const inc = await tx.playerIncentive.findUniqueOrThrow({ where: { id: incentiveId } });
  const w = await tx.wallet.findUnique({ where: { userId: inc.userId } });
  const left = w ? Math.max(0, cents(w.bonus)) : 0;
  if (w && Number(w.bonus) !== 0) await tx.wallet.update({ where: { id: w.id }, data: { bonus: 0 } });
  if (left > 0) await tx.bonusTransaction.create({ data: { incentiveId, type: "FORFEIT", amount: dec(-left), bonusAfter: 0 } });
  await tx.playerIncentive.update({
    where: { id: incentiveId },
    data: { forfeited: dec(left), ...(note ? { note: inc.note ? `${inc.note} · ${note}` : note } : {}) },
  });
  return { forfeited: left };
}

/** Rollover cumprido: o saldo de bônus vira saldo real (lançamento BONUS), até o teto de conversão. */
async function completeTx(tx: Tx, incentiveId: string) {
  const claimed = await tx.playerIncentive.updateMany({
    where: { id: incentiveId, status: "ACTIVE" },
    data: { status: "COMPLETED", activeKey: null, endedAt: new Date() },
  });
  if (claimed.count !== 1) return null;
  const inc = await tx.playerIncentive.findUniqueOrThrow({ where: { id: incentiveId } });
  const w = await tx.wallet.findUniqueOrThrow({ where: { userId: inc.userId } });
  const { converted, forfeited } = conversion(cents(w.bonus), num(inc.maxConversion));
  const w2 = await tx.wallet.update({ where: { id: w.id }, data: { bonus: 0, balance: { increment: dec(converted) } } });
  if (converted > 0) {
    await tx.walletTransaction.create({
      data: {
        walletId: w.id, type: "BONUS", amount: dec(converted), balanceAfter: w2.balance, reference: `incentivo:${incentiveId}`,
        meta: JSON.stringify({ source: "incentive", campaignId: inc.campaignId }),
      },
    });
    await tx.bonusTransaction.create({ data: { incentiveId, type: "CONVERT", amount: dec(-converted), bonusAfter: dec(forfeited) } });
  }
  if (forfeited > 0) await tx.bonusTransaction.create({ data: { incentiveId, type: "FORFEIT", amount: dec(-forfeited), bonusAfter: 0 } });
  await tx.playerIncentive.update({ where: { id: incentiveId }, data: { converted: dec(converted), forfeited: dec(forfeited) } });
  return { converted, forfeited };
}

/* ───────────── prazo ───────────── */

/** Incentivo vencido do jogador: encerra agora (antes de mostrar, apostar ou sacar). */
export async function expireIfDue(userId: string, now = new Date()) {
  const inc = await prisma.playerIncentive.findUnique({ where: { activeKey: userId }, select: { id: true, expiresAt: true } });
  if (!inc || inc.expiresAt > now) return false;
  await prisma.$transaction((tx) => endTx(tx, inc.id, "EXPIRED", null));
  return true;
}

/** Varredura dos vencidos (roda a cada minuto). */
export async function expireDueIncentives(now = new Date()) {
  const due = await prisma.playerIncentive.findMany({ where: { status: "ACTIVE", expiresAt: { lte: now } }, select: { id: true }, take: 500 });
  for (const d of due) await prisma.$transaction((tx) => endTx(tx, d.id, "EXPIRED", null));
  return due.length;
}

let sweeper: NodeJS.Timeout | null = null;
export function startIncentiveSweeper(log?: (msg: string, err: unknown) => void) {
  if (sweeper) return;
  const run = () => expireDueIncentives().catch((e) => log?.("incentivos: falha ao encerrar os vencidos", e));
  run();
  sweeper = setInterval(run, 60_000);
  sweeper.unref();
}
export function stopIncentiveSweeper() {
  if (sweeper) clearInterval(sweeper);
  sweeper = null;
}

/* ───────────── cassino: saldo e rodadas ───────────── */

/**
 * Saldo que o jogo mostra: real + bônus quando o jogo é da campanha ativa. Sem jogo informado (o aviso de saldo da
 * PlayFivers não diz qual jogo), vale o último que o jogador abriu.
 */
export async function playableBalance(userId: string, gameId?: string | null): Promise<number> {
  const w = await prisma.wallet.findUnique({ where: { userId }, select: { balance: true, bonus: true } });
  if (!w) return 0;
  const real = cents(w.balance), bonus = cents(w.bonus);
  if (bonus <= 0) return real;
  const inc = await prisma.playerIncentive.findUnique({ where: { activeKey: userId }, select: { campaignId: true, expiresAt: true } });
  if (!inc || inc.expiresAt <= new Date()) return real;
  const gid = gameId ?? (await prisma.casinoSession.findFirst({ where: { userId }, orderBy: { startedAt: "desc" }, select: { gameId: true } }))?.gameId;
  if (!gid) return real;
  const hit = await prisma.incentiveGame.findUnique({ where: { campaignId_gameId: { campaignId: inc.campaignId, gameId: gid } }, select: { gameId: true } });
  return hit ? r2(real + bonus) : real;
}

export interface RoundInput {
  userId: string; walletId: string; gameId: string | null; bet: number; win: number; roundId?: string; reference: string;
  ext: { bet: string; win: string; bonusBet: string; bonusWin: string };
}

/**
 * Uma rodada do cassino (aposta + prêmio), dentro da transação. Dinheiro real primeiro; nos jogos da campanha ativa
 * o bônus cobre o que faltar e o prêmio volta na mesma proporção. A aposta soma ao rollover (até a aposta máxima);
 * ao cumprir, o bônus vira saldo real; bônus zerado encerra o incentivo. Devolve o saldo que o jogo deve mostrar.
 */
export async function settleRoundTx(tx: Tx, p: RoundInput): Promise<number> {
  const now = new Date();
  let inc = await tx.playerIncentive.findUnique({ where: { activeKey: p.userId } });
  if (inc && inc.expiresAt <= now) {
    await endTx(tx, inc.id, "EXPIRED", null);
    inc = null;
  }
  const eligible = !!inc && (await isCampaignGame(tx, inc.campaignId, p.gameId));
  const w = await tx.wallet.findUniqueOrThrow({ where: { id: p.walletId } });
  const split = splitStake(p.bet, Number(w.balance), Number(w.bonus), eligible);
  if (!split) throw new AppError("Saldo insuficiente", 400, "INSUFFICIENT_FUNDS");

  let real = w.balance;
  if (split.real > 0) {
    const amt = dec(split.real);
    const ok = await tx.wallet.updateMany({ where: { id: p.walletId, balance: { gte: amt } }, data: { balance: { decrement: amt } } });
    if (ok.count === 0) throw new AppError("Saldo insuficiente", 400, "INSUFFICIENT_FUNDS");
    real = (await tx.wallet.findUniqueOrThrow({ where: { id: p.walletId } })).balance;
    await tx.walletTransaction.create({
      data: { walletId: p.walletId, type: "CASINO_BET", amount: amt.negated(), balanceAfter: real, gameId: p.gameId, roundId: p.roundId, externalId: p.ext.bet, reference: p.reference },
    });
  }
  if (split.bonus > 0) {
    const amt = dec(split.bonus);
    const ok = await tx.wallet.updateMany({ where: { id: p.walletId, bonus: { gte: amt } }, data: { bonus: { decrement: amt } } });
    if (ok.count === 0) throw new AppError("Saldo insuficiente", 400, "INSUFFICIENT_FUNDS");
  }

  // Prêmio: na proporção da aposta. Prêmio sem aposta (rodada em duas mensagens) usa a proporção da aposta da rodada.
  let prize = { real: r2(Math.max(0, p.win)), bonus: 0 };
  if (eligible && inc && p.win > 0) {
    if (p.bet > 0) prize = splitWin(p.win, p.bet, split.bonus);
    else if (p.roundId) {
      const prev = await tx.bonusTransaction.findFirst({ where: { incentiveId: inc.id, roundId: p.roundId, type: "BET" }, orderBy: { createdAt: "desc" } });
      if (prev?.stake) prize = splitWin(p.win, Number(prev.stake), -Number(prev.amount));
    }
  }
  if (prize.real > 0) {
    const amt = dec(prize.real);
    real = (await tx.wallet.update({ where: { id: p.walletId }, data: { balance: { increment: amt } } })).balance;
    await tx.walletTransaction.create({
      data: { walletId: p.walletId, type: "CASINO_WIN", amount: amt, balanceAfter: real, gameId: p.gameId, roundId: p.roundId, externalId: p.ext.win, reference: p.reference },
    });
  }
  if (!eligible || !inc) return cents(real);

  // Parte do bônus e rollover.
  const afterBet = r2(Number(w.bonus) - split.bonus);
  const afterWin = r2(afterBet + prize.bonus);
  if (prize.bonus > 0) await tx.wallet.update({ where: { id: p.walletId }, data: { bonus: { increment: dec(prize.bonus) } } });
  const counted = rolloverContribution(p.bet, num(inc.maxBet));
  if (p.bet > 0) {
    await tx.bonusTransaction.create({
      data: {
        incentiveId: inc.id, type: "BET", amount: dec(-split.bonus), bonusAfter: dec(afterBet), stake: dec(p.bet), rollover: dec(counted),
        gameId: p.gameId, roundId: p.roundId, externalId: p.ext.bonusBet,
      },
    });
  }
  if (prize.bonus > 0) {
    await tx.bonusTransaction.create({
      data: { incentiveId: inc.id, type: "WIN", amount: dec(prize.bonus), bonusAfter: dec(afterWin), gameId: p.gameId, roundId: p.roundId, externalId: p.ext.bonusWin },
    });
  }
  let done = Number(inc.rolloverDone);
  if (counted > 0) {
    done = Number((await tx.playerIncentive.update({ where: { id: inc.id }, data: { rolloverDone: { increment: dec(counted) } } })).rolloverDone);
  }
  let stillActive = true;
  if (rolloverReached(done, Number(inc.rolloverTarget))) {
    await completeTx(tx, inc.id);
    stillActive = false;
  } else if (afterWin <= 0) {
    await endTx(tx, inc.id, "LOST", null); // bônus todo apostado e perdido: nada mais a converter
    stillActive = false;
  }
  const wf = await tx.wallet.findUniqueOrThrow({ where: { id: p.walletId }, select: { balance: true, bonus: true } });
  return cents(Number(wf.balance) + (stillActive ? Number(wf.bonus) : 0));
}

/**
 * Estorno da parte do bônus de uma rodada: devolve a aposta paga com bônus, retira o prêmio que foi para o bônus
 * e desfaz o rollover. Só enquanto o incentivo está ativo; depois de encerrado (convertido, expirado, cancelado)
 * a parte do bônus não volta.
 */
export async function refundBonusTx(tx: Tx, p: { bet: BonusTransaction | null; win: BonusTransaction | null; ext: { bet: string; win: string } }) {
  const any = p.bet ?? p.win;
  if (!any) return;
  const inc = await tx.playerIncentive.findUnique({ where: { id: any.incentiveId } });
  if (!inc || inc.status !== "ACTIVE") return;
  const w = await tx.wallet.findUniqueOrThrow({ where: { userId: inc.userId } });
  let bonus = cents(w.bonus);
  if (p.bet) {
    const back = Math.max(0, -Number(p.bet.amount));
    const counted = Math.min(Math.max(0, Number(p.bet.rollover)), Number(inc.rolloverDone));
    bonus = r2(bonus + back);
    if (back > 0) await tx.wallet.update({ where: { id: w.id }, data: { bonus: { increment: dec(back) } } });
    if (counted > 0) await tx.playerIncentive.update({ where: { id: inc.id }, data: { rolloverDone: { decrement: dec(counted) } } });
    await tx.bonusTransaction.create({
      data: { incentiveId: inc.id, type: "REFUND", amount: dec(back), bonusAfter: dec(bonus), rollover: dec(-counted), gameId: p.bet.gameId, roundId: p.bet.roundId, externalId: p.ext.bet },
    });
  }
  if (p.win) {
    const take = Math.min(Math.max(0, Number(p.win.amount)), bonus); // nunca deixa o bônus negativo
    bonus = r2(bonus - take);
    if (take > 0) await tx.wallet.update({ where: { id: w.id }, data: { bonus: { decrement: dec(take) } } });
    await tx.bonusTransaction.create({
      data: { incentiveId: inc.id, type: "REFUND", amount: dec(-take), bonusAfter: dec(bonus), gameId: p.win.gameId, roundId: p.win.roundId, externalId: p.ext.win },
    });
  }
}

/* ───────────── jogador ───────────── */

async function eligibilityCtx(userId: string, c: IncentiveCampaign, now: Date, extra: { deposit?: number; excludeOrderId?: string } = {}): Promise<EligibilityCtx> {
  const enabled = await enabledWallets();
  const [prot, active, used, paid, games] = await Promise.all([
    loadProtection(userId),
    prisma.playerIncentive.findUnique({ where: { activeKey: userId }, select: { id: true } }),
    prisma.playerIncentive.count({ where: { userId, campaignId: c.id } }),
    prisma.pixOrder.count({ where: { userId, kind: "DEPOSIT", status: "PAID", ...(extra.excludeOrderId ? { id: { not: extra.excludeOrderId } } : {}) } }),
    prisma.incentiveGame.count({ where: { campaignId: c.id, game: onSite(enabled) } }),
  ]);
  return { now, mode: prot.mode, hasActive: !!active, usedCount: used, paidDeposits: paid, gamesOnSite: games, deposit: extra.deposit };
}

const publicCampaign = (c: IncentiveCampaign) => ({
  id: c.id, name: c.name, description: c.description, trigger: c.trigger,
  bonusPercent: num(c.bonusPercent), bonusFixed: num(c.bonusFixed), maxBonus: num(c.maxBonus), minDeposit: num(c.minDeposit),
  firstDepositOnly: c.firstDepositOnly, requireDeposit: c.requireDeposit,
  rolloverTimes: Number(c.rolloverTimes), rolloverBase: c.rolloverBase, maxBet: num(c.maxBet), maxConversion: num(c.maxConversion),
  validDays: c.validDays, endsAt: c.endsAt,
});

/** Tela "Incentivos" do site: o incentivo em andamento, as campanhas abertas (com o motivo de não poder) e o histórico. */
export async function playerIncentives(userId: string | null) {
  const now = new Date();
  if (userId) await expireIfDue(userId, now);
  const enabled = await enabledWallets();
  const campaigns = (await prisma.incentiveCampaign.findMany({
    where: { trigger: { in: ["DEPOSIT", "CLAIM"] }, active: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
  })).filter((c) => campaignWindow(c, now) === "OPEN");
  const previews = await Promise.all(campaigns.map((c) => siteGames(c.id, enabled, 12)));

  let active = null;
  let history: unknown[] = [];
  let ctxBase: Omit<EligibilityCtx, "usedCount" | "gamesOnSite"> | null = null;
  let usedBy = new Map<string, number>();
  if (userId) {
    const [prot, wallet, inc, used, paid, past] = await Promise.all([
      loadProtection(userId),
      prisma.wallet.findUnique({ where: { userId }, select: { bonus: true } }),
      prisma.playerIncentive.findUnique({ where: { activeKey: userId }, include: { campaign: true } }),
      prisma.playerIncentive.groupBy({ by: ["campaignId"], where: { userId }, _count: { _all: true } }),
      prisma.pixOrder.count({ where: { userId, kind: "DEPOSIT", status: "PAID" } }),
      prisma.playerIncentive.findMany({
        where: { userId, status: { not: "ACTIVE" } }, include: { campaign: { select: { name: true } } }, orderBy: { grantedAt: "desc" }, take: 10,
      }),
    ]);
    usedBy = new Map(used.map((u) => [u.campaignId, u._count._all]));
    ctxBase = { now, mode: prot.mode, hasActive: !!inc, paidDeposits: paid };
    if (inc) {
      const [preview, ids] = await Promise.all([
        siteGames(inc.campaignId, enabled, 24),
        prisma.incentiveGame.findMany({ where: { campaignId: inc.campaignId, game: onSite(enabled) }, select: { gameId: true } }),
      ]);
      const target = Number(inc.rolloverTarget), done = Number(inc.rolloverDone);
      active = {
        id: inc.id, campaign: publicCampaign(inc.campaign),
        bonusAmount: n0(inc.bonusAmount), bonusBalance: cents(wallet?.bonus ?? 0), depositAmount: num(inc.depositAmount),
        rolloverTarget: target, rolloverDone: r2(done), rolloverLeft: rolloverLeft(done, target), progress: rolloverProgress(done, target),
        maxBet: num(inc.maxBet), maxConversion: num(inc.maxConversion), grantedAt: inc.grantedAt, expiresAt: inc.expiresAt,
        games: preview.games, gamesTotal: preview.total, gameIds: ids.map((x) => x.gameId),
      };
    }
    history = past.map((h) => ({
      id: h.id, name: h.campaign.name, status: h.status, bonusAmount: n0(h.bonusAmount), converted: num(h.converted), forfeited: num(h.forfeited),
      rolloverTarget: Number(h.rolloverTarget), rolloverDone: r2(Number(h.rolloverDone)), grantedAt: h.grantedAt, endedAt: h.endedAt,
    }));
  }

  const available = campaigns.map((c, i) => {
    const reason = ctxBase
      ? ineligibleReason(rulesOf(c), { ...ctxBase, usedCount: usedBy.get(c.id) ?? 0, gamesOnSite: previews[i].total })
      : previews[i].total > 0 ? null : "Os jogos desta campanha não estão disponíveis no momento.";
    return { ...publicCampaign(c), games: previews[i].games, gamesTotal: previews[i].total, canTake: !reason, reason };
  });
  return { loggedIn: !!userId, active, available, history };
}

/** O jogador ativa uma campanha de resgate (CLAIM). */
export async function claimIncentive(userId: string, campaignId: string) {
  const now = new Date();
  await expireIfDue(userId, now);
  const c = await prisma.incentiveCampaign.findUnique({ where: { id: campaignId } });
  if (!c || c.trigger !== "CLAIM") throw new AppError("Campanha não encontrada", 404, "NOT_FOUND");
  const reason = ineligibleReason(rulesOf(c), await eligibilityCtx(userId, c, now));
  if (reason) throw new AppError(reason, 409, "NOT_ELIGIBLE");
  const bonus = r2(num(c.bonusFixed) ?? 0);
  try {
    const inc = await prisma.$transaction((tx) => grantTx(tx, { userId, campaign: c, bonus, deposit: null, now }));
    return { ok: true, incentiveId: inc.id, bonus, rolloverTarget: Number(inc.rolloverTarget), expiresAt: inc.expiresAt };
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError("Você já tem um incentivo em andamento.", 409, "NOT_ELIGIBLE");
    throw e;
  }
}

/** O jogador desiste do incentivo em andamento: o saldo de bônus é retirado e o saque fica liberado. */
export async function cancelActiveIncentive(userId: string) {
  const inc = await prisma.playerIncentive.findUnique({ where: { activeKey: userId }, select: { id: true } });
  if (!inc) throw new AppError("Você não tem incentivo em andamento.", 404, "NOT_FOUND");
  const r = await prisma.$transaction((tx) => endTx(tx, inc.id, "CANCELLED", null, "cancelado pelo jogador"));
  if (!r) throw new AppError("Esse incentivo já foi encerrado.", 409, "ALREADY_ENDED");
  return { ok: true, forfeited: r.forfeited };
}

/** Saque com incentivo em andamento: bloqueado até cumprir o rollover ou cancelar o incentivo. */
export async function assertNoActiveIncentive(userId: string) {
  await expireIfDue(userId);
  const inc = await prisma.playerIncentive.findUnique({ where: { activeKey: userId }, include: { campaign: { select: { name: true } } } });
  if (!inc) return;
  const left = rolloverLeft(Number(inc.rolloverDone), Number(inc.rolloverTarget));
  throw new AppError(
    `Você tem um incentivo em andamento (${inc.campaign.name}): faltam ${brl(left)} em apostas nos jogos da campanha para liberar o saque. Cumpra o rollover ou cancele o incentivo em Incentivos.`,
    409,
    "INCENTIVE_ACTIVE",
  );
}

/* ───────────── depósito com bônus ───────────── */

/** Pedido de depósito com campanha: confere se vale agora. O bônus só entra quando o PIX cair. */
export async function checkDepositCampaign(userId: string, campaignId: string, amount: number) {
  const now = new Date();
  await expireIfDue(userId, now);
  const c = await prisma.incentiveCampaign.findUnique({ where: { id: campaignId } });
  if (!c || c.trigger !== "DEPOSIT") throw new AppError("Campanha de bônus não encontrada", 404, "NOT_FOUND");
  const reason = ineligibleReason(rulesOf(c), await eligibilityCtx(userId, c, now, { deposit: amount }));
  if (reason) throw new AppError(reason, 409, "NOT_ELIGIBLE");
  return { bonus: depositBonus(rulesOf(c), amount) };
}

const noteOrder = async (orderId: string, text: string) => {
  const o = await prisma.pixOrder.findUnique({ where: { id: orderId }, select: { note: true } });
  await prisma.pixOrder.update({ where: { id: orderId }, data: { note: (o?.note ? `${o.note} · ${text}` : text).slice(0, 300) } });
};

/**
 * Depósito pago com campanha escolhida: concede o bônus (uma vez por ordem). Roda depois do crédito, em transação
 * própria — nunca desfaz o depósito; se a campanha não valer mais, o motivo fica anotado na ordem (admin).
 * O período da campanha conta pela hora do pedido (quem pediu dentro do prazo e pagou depois, recebe).
 */
export async function applyDepositIncentive(orderId: string) {
  const order = await prisma.pixOrder.findUnique({ where: { id: orderId } });
  if (!order || order.kind !== "DEPOSIT" || order.status !== "PAID" || !order.campaignId) return null;
  if (await prisma.playerIncentive.findUnique({ where: { pixOrderId: orderId }, select: { id: true } })) return null;
  await expireIfDue(order.userId);
  const c = await prisma.incentiveCampaign.findUnique({ where: { id: order.campaignId } });
  const amount = Number(order.amount);
  const reason = !c
    ? "a campanha foi excluída"
    : ineligibleReason(rulesOf(c), await eligibilityCtx(order.userId, c, order.createdAt, { deposit: amount, excludeOrderId: orderId }));
  if (!c || reason) {
    await noteOrder(orderId, `Bônus não aplicado: ${reason}`);
    return null;
  }
  try {
    return await prisma.$transaction((tx) => grantTx(tx, { userId: order.userId, campaign: c, bonus: depositBonus(rulesOf(c), amount), deposit: amount, pixOrderId: orderId, now: new Date() }));
  } catch (e) {
    if (isUniqueViolation(e)) {
      await noteOrder(orderId, "Bônus não aplicado: o jogador já tinha um incentivo em andamento");
      return null;
    }
    throw e;
  }
}

/* ───────────── admin ───────────── */

const STATUSES = ["ACTIVE", "COMPLETED", "EXPIRED", "CANCELLED", "LOST"] as const;

/** Tela Incentivos → Campanhas: campanhas com números e o resumo dos últimos 30 dias. */
export async function incentivesAdminView() {
  const now = new Date();
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const enabled = await enabledWallets();
  const [campaigns, byStatus, onSiteCounts, outstanding, granted30, ended30] = await Promise.all([
    prisma.incentiveCampaign.findMany({
      orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
      include: {
        _count: { select: { games: true } },
        games: { orderBy: { position: "asc" }, take: 14, select: { game: { select: GAME_VIEW } } },
      },
    }),
    prisma.playerIncentive.groupBy({ by: ["campaignId", "status"], _count: { _all: true }, _sum: { bonusAmount: true, converted: true } }),
    prisma.incentiveGame.groupBy({ by: ["campaignId"], where: { game: onSite(enabled) }, _count: { _all: true } }),
    prisma.wallet.aggregate({ where: { user: { role: "PLAYER" } }, _sum: { bonus: true } }),
    prisma.playerIncentive.aggregate({ where: { grantedAt: { gte: since } }, _sum: { bonusAmount: true }, _count: { _all: true } }),
    prisma.playerIncentive.aggregate({ where: { endedAt: { gte: since } }, _sum: { converted: true, forfeited: true } }),
  ]);
  const activeCount = byStatus.filter((s) => s.status === "ACTIVE").reduce((a, s) => a + s._count._all, 0);
  const site = new Map(onSiteCounts.map((g) => [g.campaignId, g._count._all]));
  return {
    enabledWallets: enabled,
    summary: {
      active: activeCount,
      outstanding: cents(outstanding._sum.bonus ?? 0),
      granted30: cents(granted30._sum.bonusAmount ?? 0), granted30N: granted30._count._all,
      converted30: cents(ended30._sum.converted ?? 0), forfeited30: cents(ended30._sum.forfeited ?? 0),
    },
    campaigns: campaigns.map((c) => {
      const rows = byStatus.filter((s) => s.campaignId === c.id);
      const count = (st: string) => rows.find((r) => r.status === st)?._count._all ?? 0;
      return {
        ...publicCampaign(c), active: c.active, startsAt: c.startsAt, endsAt: c.endsAt, maxPerPlayer: c.maxPerPlayer, sortOrder: c.sortOrder,
        window: campaignWindow(c, now), gamesTotal: c._count.games, gamesOnSite: site.get(c.id) ?? 0,
        games: c.games.map((g) => gameView(g.game, enabled)),
        stats: {
          grants: rows.reduce((a, r) => a + r._count._all, 0),
          ...Object.fromEntries(STATUSES.map((s) => [s.toLowerCase(), count(s)])),
          bonus: cents(rows.reduce((a, r) => a + n0(r._sum.bonusAmount), 0)),
          converted: cents(rows.reduce((a, r) => a + n0(r._sum.converted), 0)),
        },
      };
    }),
  };
}

/** Campanha completa para editar (com todos os jogos). */
export async function getCampaign(id: string) {
  const c = await prisma.incentiveCampaign.findUnique({
    where: { id },
    include: { games: { orderBy: { position: "asc" }, select: { game: { select: GAME_VIEW } } }, _count: { select: { grants: true } } },
  });
  if (!c) throw new AppError("Campanha não encontrada", 404, "NOT_FOUND");
  const enabled = await enabledWallets();
  return {
    ...publicCampaign(c), active: c.active, startsAt: c.startsAt, endsAt: c.endsAt, maxPerPlayer: c.maxPerPlayer, sortOrder: c.sortOrder,
    grants: c._count.grants, games: c.games.map((g) => gameView(g.game, enabled)),
  };
}

const chunks = <T,>(arr: T[], size: number) => Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, i * size + size));

export async function saveCampaign(id: string | null, input: CampaignInput, adminId: string) {
  const gameIds = [...new Set(input.gameIds)];
  let found = 0;
  for (const part of chunks(gameIds, 400)) found += await prisma.game.count({ where: { id: { in: part } } });
  if (found !== gameIds.length) throw new AppError("Algum jogo escolhido não existe mais. Atualize a tela.", 400, "VALIDATION");
  if (id && !(await prisma.incentiveCampaign.findUnique({ where: { id }, select: { id: true } }))) throw new AppError("Campanha não encontrada", 404, "NOT_FOUND");
  const isDeposit = input.trigger === "DEPOSIT";
  const data = {
    name: input.name, description: input.description, trigger: input.trigger, active: input.active,
    startsAt: input.startsAt ? new Date(input.startsAt) : null, endsAt: input.endsAt ? new Date(input.endsAt) : null,
    bonusPercent: isDeposit && input.bonusPercent != null ? dec(input.bonusPercent) : null,
    bonusFixed: !isDeposit && input.bonusFixed != null ? dec(input.bonusFixed) : null,
    maxBonus: isDeposit && input.maxBonus != null ? dec(input.maxBonus) : null,
    minDeposit: isDeposit && input.minDeposit != null ? dec(input.minDeposit) : null,
    firstDepositOnly: isDeposit && input.firstDepositOnly,
    requireDeposit: input.trigger === "CLAIM" && input.requireDeposit,
    rolloverTimes: new Decimal(input.rolloverTimes).toDecimalPlaces(2), rolloverBase: isDeposit ? input.rolloverBase : "BONUS",
    maxBet: input.maxBet != null ? dec(input.maxBet) : null, maxConversion: input.maxConversion != null ? dec(input.maxConversion) : null,
    validDays: input.validDays, maxPerPlayer: input.maxPerPlayer, sortOrder: input.sortOrder,
  };
  return prisma.$transaction(async (tx) => {
    const c = id ? await tx.incentiveCampaign.update({ where: { id }, data }) : await tx.incentiveCampaign.create({ data });
    await tx.incentiveGame.deleteMany({ where: { campaignId: c.id } });
    for (const part of chunks(gameIds.map((gameId, position) => ({ campaignId: c.id, gameId, position })), 400)) {
      await tx.incentiveGame.createMany({ data: part });
    }
    await tx.adminAuditLog.create({
      data: {
        adminId, action: id ? "INCENTIVE_CAMPAIGN_UPDATE" : "INCENTIVE_CAMPAIGN_CREATE", target: c.id,
        payload: JSON.stringify({ name: c.name, trigger: c.trigger, active: c.active, rolloverTimes: input.rolloverTimes, games: gameIds.length }),
      },
    });
    return c;
  });
}

export async function deleteCampaign(id: string, adminId: string) {
  const c = await prisma.incentiveCampaign.findUnique({ where: { id }, select: { name: true, _count: { select: { grants: true } } } });
  if (!c) throw new AppError("Campanha não encontrada", 404, "NOT_FOUND");
  if (c._count.grants > 0) throw new AppError("Esta campanha já foi usada por jogadores e fica no histórico. Desligue-a em vez de excluir.", 409, "IN_USE");
  await prisma.$transaction([
    prisma.incentiveCampaign.delete({ where: { id } }),
    prisma.adminAuditLog.create({ data: { adminId, action: "INCENTIVE_CAMPAIGN_DELETE", target: id, payload: c.name } }),
  ]);
  return { ok: true };
}

/** Jogador pelo id, e-mail ou CPF (com ou sem pontuação). */
async function findPlayer(term: string) {
  const t = term.trim();
  const digits = t.replace(/\D/g, "");
  const u = await prisma.user.findFirst({
    where: { OR: [{ id: t }, { email: t.toLowerCase() }, ...(digits.length === 11 ? [{ cpf: digits }] : [])] },
    select: { id: true, email: true, displayName: true, role: true },
  });
  if (!u || u.role !== "PLAYER") throw new AppError("Jogador não encontrado (use o id, o e-mail ou o CPF).", 404, "NOT_FOUND");
  return u;
}

/** A equipe concede um incentivo a um jogador (qualquer campanha; o valor pode ser outro). */
export async function grantManual(adminId: string, input: { campaignId: string; user: string; amount?: number; note: string }) {
  const c = await prisma.incentiveCampaign.findUnique({ where: { id: input.campaignId } });
  if (!c) throw new AppError("Campanha não encontrada", 404, "NOT_FOUND");
  const u = await findPlayer(input.user);
  const now = new Date();
  await expireIfDue(u.id, now);
  const ctx = await eligibilityCtx(u.id, c, now);
  if (ctx.mode !== "OPERATIONAL") throw new AppError("Este jogador está bloqueado ou em autoexclusão e não pode receber bônus.", 409, "PLAYER_RESTRICTED");
  if (ctx.hasActive) throw new AppError("Este jogador já tem um incentivo em andamento. Cancele-o antes de conceder outro.", 409, "NOT_ELIGIBLE");
  if (ctx.gamesOnSite <= 0) throw new AppError("Nenhum jogo desta campanha aparece no site agora (confira as carteiras habilitadas).", 409, "NOT_ELIGIBLE");
  const bonus = r2(input.amount ?? num(c.bonusFixed) ?? 0);
  if (!(bonus > 0)) throw new AppError("Informe o valor do bônus.", 400, "VALIDATION");
  try {
    const inc = await prisma.$transaction((tx) => grantTx(tx, { userId: u.id, campaign: c, bonus, deposit: null, now, grantedBy: adminId, note: input.note }));
    return { ok: true, incentiveId: inc.id, user: { id: u.id, email: u.email, name: u.displayName }, bonus, rolloverTarget: Number(inc.rolloverTarget) };
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError("Este jogador já tem um incentivo em andamento.", 409, "NOT_ELIGIBLE");
    throw e;
  }
}

/** A equipe cancela um incentivo em andamento (o saldo de bônus é retirado). */
export async function cancelByAdmin(adminId: string, incentiveId: string, note: string) {
  const r = await prisma.$transaction(async (tx) => {
    const out = await endTx(tx, incentiveId, "CANCELLED", adminId, note ? `cancelado pela equipe: ${note}` : "cancelado pela equipe");
    if (out) await tx.adminAuditLog.create({ data: { adminId, action: "INCENTIVE_CANCEL", target: incentiveId, payload: JSON.stringify({ forfeited: out.forfeited, note }) } });
    return out;
  });
  if (!r) throw new AppError("Esse incentivo já foi encerrado.", 409, "ALREADY_ENDED");
  return { ok: true, forfeited: r.forfeited };
}

/** Lista dos incentivos dos jogadores (filtro por situação, campanha, jogador ou busca). */
export async function grantsList(q: { status: string; campaignId?: string; userId?: string; q?: string; page: number; size: number }) {
  const term = q.q?.trim();
  const digits = term?.replace(/\D/g, "") ?? "";
  const base: Prisma.PlayerIncentiveWhereInput = {
    ...(q.campaignId ? { campaignId: q.campaignId } : {}),
    ...(q.userId ? { userId: q.userId } : {}),
    ...(term
      ? { user: { OR: [{ email: { contains: term.toLowerCase() } }, { displayName: { contains: term } }, { id: term }, ...(digits.length >= 6 ? [{ cpf: { contains: digits } }] : [])] } }
      : {}),
  };
  const where = q.status !== "all" ? { ...base, status: q.status } : base;
  const [total, rows, counts] = await Promise.all([
    prisma.playerIncentive.count({ where }),
    prisma.playerIncentive.findMany({
      where, orderBy: { grantedAt: "desc" }, skip: (q.page - 1) * q.size, take: q.size,
      include: { campaign: { select: { id: true, name: true, trigger: true } }, user: { select: { id: true, email: true, displayName: true, wallet: { select: { bonus: true } } } } },
    }),
    prisma.playerIncentive.groupBy({ by: ["status"], where: base, _count: { _all: true } }),
  ]);
  const adminIds = [...new Set(rows.flatMap((r) => [r.grantedBy, r.endedBy]).filter((x): x is string => !!x))];
  const admins = adminIds.length ? await prisma.user.findMany({ where: { id: { in: adminIds } }, select: { id: true, email: true } }) : [];
  const emailOf = new Map(admins.map((a) => [a.id, a.email]));
  return {
    total, page: q.page, size: q.size,
    counts: Object.fromEntries(STATUSES.map((s) => [s, counts.find((c) => c.status === s)?._count._all ?? 0])),
    rows: rows.map((r) => {
      const target = Number(r.rolloverTarget), done = Number(r.rolloverDone);
      return {
        id: r.id, status: r.status,
        user: { id: r.user.id, email: r.user.email, name: r.user.displayName },
        campaign: r.campaign,
        bonusAmount: n0(r.bonusAmount), depositAmount: num(r.depositAmount),
        bonusBalance: r.status === "ACTIVE" ? cents(r.user.wallet?.bonus ?? 0) : null,
        rolloverTarget: target, rolloverDone: r2(done), progress: rolloverProgress(done, target),
        converted: num(r.converted), forfeited: num(r.forfeited), maxBet: num(r.maxBet), maxConversion: num(r.maxConversion),
        grantedAt: r.grantedAt, expiresAt: r.expiresAt, endedAt: r.endedAt, note: r.note,
        grantedBy: r.grantedBy ? emailOf.get(r.grantedBy) ?? "equipe" : null, endedBy: r.endedBy ? emailOf.get(r.endedBy) ?? "equipe" : null,
      };
    }),
  };
}

/** Extrato do bônus de um incentivo (concessão, apostas, prêmios, estornos, conversão e retirada). */
export async function grantLedger(id: string) {
  const inc = await prisma.playerIncentive.findUnique({
    where: { id },
    include: { campaign: { select: { name: true } }, user: { select: { id: true, email: true, displayName: true } } },
  });
  if (!inc) throw new AppError("Incentivo não encontrado", 404, "NOT_FOUND");
  const txs = await prisma.bonusTransaction.findMany({
    where: { incentiveId: id }, orderBy: { createdAt: "desc" }, take: 300,
    select: { id: true, type: true, amount: true, bonusAfter: true, stake: true, rollover: true, roundId: true, createdAt: true, game: { select: { name: true } } },
  });
  return {
    id: inc.id, status: inc.status, campaign: inc.campaign.name, user: { id: inc.user.id, email: inc.user.email, name: inc.user.displayName },
    rows: txs.map((t) => ({
      id: t.id, type: t.type, amount: n0(t.amount), bonusAfter: n0(t.bonusAfter), stake: num(t.stake), rollover: n0(t.rollover),
      game: t.game?.name ?? null, roundId: t.roundId, at: t.createdAt,
    })),
  };
}
