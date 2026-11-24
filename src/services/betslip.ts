import { Decimal } from "@prisma/client/runtime/library";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";

export type Outcome = "home" | "draw" | "away";

export interface SelectionInput {
  eventId: string;
  market?: string;
  selection: Outcome;
}

export interface PlaceBetslipInput {
  stake: number;
  selections: SelectionInput[];
  clientRef?: string;
}

/* ───────────────────────── helpers puros (testáveis) ───────────────────────── */

/** Odd combinada = produto das odds de cada seleção (acumulada). */
export function computeCombinedOdds(odds: Decimal[]): Decimal {
  const combined = odds.reduce((acc, o) => acc.mul(o), new Decimal(1));
  return combined.toDecimalPlaces(3);
}

/** Retorno potencial = stake × odd combinada (2 casas). */
export function computePotentialReturn(stake: Decimal, combinedOdds: Decimal): Decimal {
  return stake.mul(combinedOdds).toDecimalPlaces(2);
}

/** Resolve a odd de uma seleção a partir do evento (mercado 1X2). */
export function oddForSelection(
  event: { oddsHome: Decimal; oddsDraw: Decimal | null; oddsAway: Decimal },
  selection: Outcome,
): Decimal | null {
  const map: Record<Outcome, Decimal | null> = {
    home: event.oddsHome,
    draw: event.oddsDraw,
    away: event.oddsAway,
  };
  return map[selection];
}

export type LegStatus = "OPEN" | "WON" | "LOST" | "VOID";

export interface SlipResolution {
  status: "OPEN" | "WON" | "LOST" | "VOID";
  combinedOdds: Decimal; // produto das pernas não anuladas
  potentialReturn: Decimal; // stake × combinedOdds
  payout: Decimal | null; // definido quando o bilhete fecha
}

/**
 * Decide o estado de um bilhete pelas pernas. Perna anulada (evento cancelado) conta como
 * odd 1.00; se todas forem anuladas, a aposta é devolvida.
 */
export function resolveSlip(stake: Decimal, legs: { status: LegStatus; odds: Decimal }[]): SlipResolution {
  const active = legs.filter((l) => l.status !== "VOID");
  const combinedOdds = active.length ? computeCombinedOdds(active.map((l) => l.odds)) : new Decimal(1);
  const potentialReturn = computePotentialReturn(stake, combinedOdds);
  if (legs.some((l) => l.status === "LOST")) {
    return { status: "LOST", combinedOdds, potentialReturn, payout: new Decimal(0) };
  }
  if (active.length === 0) return { status: "VOID", combinedOdds, potentialReturn: stake, payout: stake };
  if (active.every((l) => l.status === "WON")) {
    return { status: "WON", combinedOdds, potentialReturn, payout: potentialReturn };
  }
  return { status: "OPEN", combinedOdds, potentialReturn, payout: null };
}

/* ───────────────────────── montagem do bilhete ───────────────────────── */

export async function placeBetslip(userId: string, input: PlaceBetslipInput) {
  // Idempotência: mesma referência de cliente não gera bilhete duplicado.
  if (input.clientRef) {
    const existing = await prisma.betslip.findUnique({
      where: { clientRef: input.clientRef },
      include: { selections: true },
    });
    if (existing) {
      if (existing.userId !== userId) {
        throw new AppError("clientRef pertence a outro usuário", 409, "CONFLICT");
      }
      return existing;
    }
  }

  const eventIds = input.selections.map((s) => s.eventId);
  if (new Set(eventIds).size !== eventIds.length) {
    throw new AppError(
      "Seleções do mesmo evento não podem compor uma acumulada",
      400,
      "DUPLICATE_EVENT",
    );
  }

  const events = await prisma.sportEvent.findMany({ where: { id: { in: eventIds } } });
  const byId = new Map(events.map((e) => [e.id, e]));

  // Resolve odds no momento da aposta (snapshot).
  const resolved = input.selections.map((sel) => {
    const event = byId.get(sel.eventId);
    if (!event) throw new AppError(`Evento ${sel.eventId} não encontrado`, 404, "NOT_FOUND");
    if (event.status === "FINISHED" || event.status === "CANCELLED") {
      throw new AppError(`Evento ${sel.eventId} não está aberto para apostas`, 400, "EVENT_CLOSED");
    }
    const odd = oddForSelection(event, sel.selection);
    if (!odd) throw new AppError("Mercado indisponível para a seleção", 400, "MARKET_UNAVAILABLE");
    return { sel, event, odd };
  });

  const stake = new Decimal(input.stake);
  const combinedOdds = computeCombinedOdds(resolved.map((r) => r.odd));
  const potentialReturn = computePotentialReturn(stake, combinedOdds);
  const type = resolved.length === 1 ? "SINGLE" : "MULTIPLE";

  return prisma.$transaction(async (tx) => {
    const wallet = await tx.wallet.findUnique({ where: { userId } });
    if (!wallet) throw new AppError("Carteira inexistente", 404, "NOT_FOUND");
    if (wallet.balance.lessThan(stake)) {
      throw new AppError("Saldo insuficiente", 400, "INSUFFICIENT_FUNDS");
    }

    const updatedWallet = await tx.wallet.update({
      where: { id: wallet.id },
      data: { balance: { decrement: stake } },
    });

    const betslip = await tx.betslip.create({
      data: {
        userId,
        type,
        stake,
        combinedOdds,
        potentialReturn,
        clientRef: input.clientRef ?? null,
        selections: {
          create: resolved.map((r) => ({
            eventId: r.event.id,
            market: r.sel.market ?? "1X2",
            selection: r.sel.selection,
            oddsAtPlacement: r.odd,
          })),
        },
      },
      include: { selections: true },
    });

    await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        type: "BET_STAKE",
        amount: stake.negated(),
        balanceAfter: updatedWallet.balance,
        reference: `betslip:${betslip.id}`,
      },
    });

    return betslip;
  });
}

/* ───────────────────────── liquidação ───────────────────────── */

/**
 * Reavalia os bilhetes afetados por um evento (liquidado ou cancelado): fecha os que
 * perderam, paga os ganhos, devolve os totalmente anulados e atualiza a odd/retorno
 * dos que seguem abertos com perna anulada.
 */
async function resolveAffectedSlips(tx: Prisma.TransactionClient, slipIds: string[]) {
  const counts = { slipsWon: 0, slipsLost: 0, slipsRefunded: 0, slipsStillOpen: 0 };
  for (const slipId of slipIds) {
    const slip = await tx.betslip.findUnique({ where: { id: slipId }, include: { selections: true } });
    if (!slip || slip.status !== "OPEN") continue;
    const r = resolveSlip(
      slip.stake,
      slip.selections.map((s) => ({ status: s.status, odds: s.oddsAtPlacement })),
    );

    if (r.status === "OPEN") {
      if (!r.combinedOdds.equals(slip.combinedOdds)) {
        await tx.betslip.update({
          where: { id: slip.id },
          data: { combinedOdds: r.combinedOdds, potentialReturn: r.potentialReturn },
        });
      }
      counts.slipsStillOpen++;
      continue;
    }

    if (r.status === "LOST") {
      await tx.betslip.update({
        where: { id: slip.id },
        data: { status: "LOST", payout: new Decimal(0), settledAt: new Date() },
      });
      counts.slipsLost++;
      continue;
    }

    // WON paga o retorno; VOID devolve a aposta.
    const payout = r.payout ?? new Decimal(0);
    const wallet = await tx.wallet.findUnique({ where: { userId: slip.userId } });
    if (wallet) {
      const updated = await tx.wallet.update({
        where: { id: wallet.id },
        data: { balance: { increment: payout } },
      });
      await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          type: r.status === "WON" ? "BET_WIN" : "BET_REFUND",
          amount: payout,
          balanceAfter: updated.balance,
          reference: `betslip:${slip.id}`,
        },
      });
    }
    await tx.betslip.update({
      where: { id: slip.id },
      data: {
        status: r.status,
        payout,
        combinedOdds: r.combinedOdds,
        potentialReturn: r.potentialReturn,
        settledAt: new Date(),
      },
    });
    if (r.status === "WON") counts.slipsWon++;
    else counts.slipsRefunded++;
  }
  return counts;
}

export async function settleEvent(eventId: string, outcome: Outcome) {
  const event = await prisma.sportEvent.findUnique({ where: { id: eventId } });
  if (!event) throw new AppError("Evento não encontrado", 404, "NOT_FOUND");
  if (event.status === "FINISHED") throw new AppError("Evento já liquidado", 400, "ALREADY_SETTLED");
  if (event.status === "CANCELLED") {
    throw new AppError("Evento cancelado não pode ser liquidado", 400, "EVENT_CANCELLED");
  }
  if (outcome === "draw" && event.oddsDraw == null) {
    throw new AppError("Este evento não tem empate", 400, "MARKET_UNAVAILABLE");
  }

  return prisma.$transaction(async (tx) => {
    await tx.sportEvent.update({
      where: { id: eventId },
      data: { result: outcome, status: "FINISHED", isLive: false, settledAt: new Date() },
    });

    const open = await tx.betSelection.findMany({ where: { eventId, status: "OPEN" } });
    for (const s of open) {
      await tx.betSelection.update({
        where: { id: s.id },
        data: { status: s.selection === outcome ? "WON" : "LOST" },
      });
    }

    const slips = await resolveAffectedSlips(tx, [...new Set(open.map((s) => s.betslipId))]);
    return { eventId, outcome, settledSelections: open.length, ...slips };
  });
}

/** Cancela o evento: seleções em aberto viram nulas e os bilhetes são reavaliados. */
export async function cancelEvent(eventId: string) {
  const event = await prisma.sportEvent.findUnique({ where: { id: eventId } });
  if (!event) throw new AppError("Evento não encontrado", 404, "NOT_FOUND");
  if (event.status === "FINISHED") {
    throw new AppError("Evento já liquidado não pode ser cancelado", 400, "ALREADY_SETTLED");
  }
  if (event.status === "CANCELLED") throw new AppError("Evento já cancelado", 400, "ALREADY_CANCELLED");

  return prisma.$transaction(async (tx) => {
    await tx.sportEvent.update({
      where: { id: eventId },
      data: { status: "CANCELLED", isLive: false, result: null, settledAt: new Date() },
    });

    const open = await tx.betSelection.findMany({ where: { eventId, status: "OPEN" } });
    if (open.length) {
      await tx.betSelection.updateMany({
        where: { id: { in: open.map((s) => s.id) } },
        data: { status: "VOID" },
      });
    }

    const slips = await resolveAffectedSlips(tx, [...new Set(open.map((s) => s.betslipId))]);
    return { eventId, voidedSelections: open.length, ...slips };
  });
}
