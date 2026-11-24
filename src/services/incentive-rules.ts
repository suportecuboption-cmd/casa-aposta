/**
 * Regras puras dos incentivos (bônus com rollover) — sem banco; testadas em test/incentives.test.ts.
 * As contas de dinheiro são feitas em centavos inteiros para não acumular erro de ponto flutuante.
 *
 * Como funciona:
 * - O bônus fica num saldo separado (Wallet.bonus) e só pode ser apostado nos jogos da campanha.
 * - Dinheiro real é usado primeiro; o bônus cobre só o que o real não cobrir.
 * - O prêmio volta na mesma proporção da aposta: a parte apostada com bônus volta para o saldo de bônus.
 * - Toda aposta nos jogos da campanha (real ou bônus) soma ao rollover; acima da aposta máxima não soma.
 * - Cumpriu o rollover: o saldo de bônus vira saldo real (até o teto de conversão, se houver).
 */

export type Trigger = "DEPOSIT" | "CLAIM" | "MANUAL";
export type RolloverBase = "BONUS" | "DEPOSIT_BONUS";
export type IncentiveStatus = "ACTIVE" | "COMPLETED" | "EXPIRED" | "CANCELLED" | "LOST";
export type AccessMode = "OPERATIONAL" | "WITHDRAW_ONLY" | "BLOCKED";

export interface CampaignRules {
  trigger: Trigger;
  active: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
  bonusPercent: number | null;
  bonusFixed: number | null;
  maxBonus: number | null;
  minDeposit: number | null;
  firstDepositOnly: boolean;
  requireDeposit: boolean;
  rolloverTimes: number;
  rolloverBase: RolloverBase;
  maxBet: number | null;
  maxConversion: number | null;
  validDays: number;
  maxPerPlayer: number;
}

export const toCents = (v: number) => Math.round(Number((v * 100).toFixed(6)));
export const fromCents = (c: number) => c / 100;
export const r2 = (v: number) => fromCents(toCents(v));
export const brl = (v: number) => `R$ ${v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Bônus de um depósito: % do valor, com teto; abaixo do depósito mínimo não há bônus. */
export function depositBonus(c: Pick<CampaignRules, "bonusPercent" | "maxBonus" | "minDeposit">, deposit: number): number {
  if (!(deposit > 0)) return 0;
  if (c.minDeposit != null && toCents(deposit) < toCents(c.minDeposit)) return 0;
  let cents = Math.floor((toCents(deposit) * (c.bonusPercent ?? 0)) / 100); // arredonda para baixo: nunca passa do %
  if (c.maxBonus != null) cents = Math.min(cents, toCents(c.maxBonus));
  return fromCents(Math.max(0, cents));
}

/** Quanto apostar nos jogos da campanha para liberar: N × bônus, ou N × (depósito + bônus). */
export function rolloverTarget(c: Pick<CampaignRules, "rolloverTimes" | "rolloverBase">, bonus: number, deposit = 0): number {
  const base = toCents(bonus) + (c.rolloverBase === "DEPOSIT_BONUS" ? toCents(deposit) : 0);
  return fromCents(Math.round(base * c.rolloverTimes));
}

/**
 * De onde sai a aposta: dinheiro real primeiro; nos jogos da campanha o bônus cobre o que faltar.
 * Fora dos jogos da campanha só vale o real. null = saldo insuficiente.
 */
export function splitStake(bet: number, real: number, bonus: number, eligible: boolean): { real: number; bonus: number } | null {
  const b = toCents(bet);
  if (b <= 0) return { real: 0, bonus: 0 };
  const fromReal = Math.min(b, Math.max(0, toCents(real)));
  const fromBonus = b - fromReal;
  if (fromBonus > (eligible ? Math.max(0, toCents(bonus)) : 0)) return null;
  return { real: fromCents(fromReal), bonus: fromCents(fromBonus) };
}

/** Prêmio dividido na mesma proporção da aposta: o que foi apostado com bônus volta para o saldo de bônus. */
export function splitWin(win: number, stake: number, stakeFromBonus: number): { real: number; bonus: number } {
  const w = toCents(win), s = toCents(stake), sb = toCents(stakeFromBonus);
  if (w <= 0) return { real: 0, bonus: 0 };
  if (s <= 0 || sb <= 0) return { real: fromCents(w), bonus: 0 };
  const toBonus = Math.round((w * Math.min(sb, s)) / s);
  return { real: fromCents(w - toBonus), bonus: fromCents(toBonus) };
}

/** Quanto a aposta soma ao rollover: inteira, ou nada se passar da aposta máxima. */
export function rolloverContribution(bet: number, maxBet: number | null): number {
  if (!(bet > 0)) return 0;
  return maxBet != null && toCents(bet) > toCents(maxBet) ? 0 : r2(bet);
}

export const rolloverReached = (done: number, target: number) => toCents(done) >= toCents(target);
export const rolloverProgress = (done: number, target: number) => (target > 0 ? Math.min(1, Math.max(0, done / target)) : 1);
export const rolloverLeft = (done: number, target: number) => fromCents(Math.max(0, toCents(target) - toCents(done)));

/** Ao cumprir: o saldo de bônus vira saldo real até o teto; o que passar é retirado. */
export function conversion(bonus: number, maxConversion: number | null): { converted: number; forfeited: number } {
  const b = Math.max(0, toCents(bonus));
  const c = maxConversion != null ? Math.min(b, Math.max(0, toCents(maxConversion))) : b;
  return { converted: fromCents(c), forfeited: fromCents(b - c) };
}

export type CampaignWindow = "OPEN" | "SCHEDULED" | "ENDED" | "PAUSED";

/** Situação da campanha agora: no ar, agendada, encerrada (passou do fim) ou pausada (desligada no admin). */
export function campaignWindow(c: Pick<CampaignRules, "active" | "startsAt" | "endsAt">, now = new Date()): CampaignWindow {
  if (!c.active) return "PAUSED";
  if (c.endsAt && now >= c.endsAt) return "ENDED";
  if (c.startsAt && now < c.startsAt) return "SCHEDULED";
  return "OPEN";
}

export const expiresAtFrom = (from: Date, days: number) => new Date(from.getTime() + days * 86_400_000);

export interface EligibilityCtx {
  now: Date;
  mode: AccessMode;
  hasActive: boolean;     // já existe incentivo em andamento
  usedCount: number;      // quantas vezes o jogador já recebeu esta campanha
  paidDeposits: number;   // depósitos pagos da conta (sem contar o do próprio pedido)
  gamesOnSite: number;    // jogos da campanha que aparecem no site agora
  deposit?: number;       // campanha de depósito: valor depositado
}

/**
 * Por que o jogador não pode receber esta campanha agora (null = pode). Mensagem pronta para a tela.
 * Os motivos definitivos vêm antes dos passageiros: quem nunca vai poder (já usou, não é o 1º depósito) não deve
 * ler "cancele o incentivo em andamento" e cancelar à toa.
 */
export function ineligibleReason(c: CampaignRules, ctx: EligibilityCtx): string | null {
  const w = campaignWindow(c, ctx.now);
  if (w === "PAUSED" || w === "ENDED") return "Esta campanha não está mais disponível.";
  if (w === "SCHEDULED") return "Esta campanha ainda não começou.";
  if (ctx.usedCount >= c.maxPerPlayer) return c.maxPerPlayer === 1 ? "Você já usou esta campanha." : `Você já usou esta campanha ${c.maxPerPlayer} vezes.`;
  if (c.trigger === "DEPOSIT" && c.firstDepositOnly && ctx.paidDeposits > 0) return "Esta campanha vale só no primeiro depósito.";
  if (ctx.gamesOnSite <= 0) return "Os jogos desta campanha não estão disponíveis no momento.";
  if (ctx.mode !== "OPERATIONAL") return "Sua conta não pode receber bônus agora. Veja os detalhes em Jogo responsável.";
  if (ctx.hasActive) return "Você já tem um incentivo em andamento. Cumpra o rollover ou cancele-o para ativar outro.";
  if (c.trigger === "DEPOSIT") {
    if (ctx.deposit !== undefined) {
      if (c.minDeposit != null && toCents(ctx.deposit) < toCents(c.minDeposit)) return `Depósito mínimo para esta campanha: ${brl(c.minDeposit)}.`;
      if (depositBonus(c, ctx.deposit) <= 0) return "Este depósito não gera bônus nesta campanha.";
    }
  }
  if (c.trigger === "CLAIM" && c.requireDeposit && ctx.paidDeposits <= 0) return "Esta campanha é para quem já fez um depósito.";
  return null;
}
