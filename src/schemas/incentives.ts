import { z } from "zod";

/* ───────── Incentivos: campanhas de bônus com rollover ───────── */

const isoDate = z.string().datetime({ offset: true, message: "Data inválida" }).nullable().default(null);
const optAmount = (min: number, max: number, label: string) =>
  z.number({ invalid_type_error: `${label}: informe um número` }).min(min, `${label}: mínimo ${min}`).max(max, `${label}: máximo ${max}`).nullable().default(null);

export const campaignInputSchema = z
  .object({
    name: z.string().trim().min(1, "Dê um nome à campanha").max(60, "Nome: até 60 caracteres"),
    description: z.string().trim().max(600, "Regras: até 600 caracteres").default(""),
    trigger: z.enum(["DEPOSIT", "CLAIM", "MANUAL"], { errorMap: () => ({ message: "Escolha como o jogador recebe o bônus" }) }),
    active: z.boolean().default(true),
    startsAt: isoDate,
    endsAt: isoDate,
    bonusPercent: optAmount(1, 1000, "% do depósito"),
    bonusFixed: optAmount(0.01, 1_000_000, "Valor do bônus"),
    maxBonus: optAmount(0.01, 1_000_000, "Bônus máximo"),
    minDeposit: optAmount(0, 50_000, "Depósito mínimo"),
    firstDepositOnly: z.boolean().default(false),
    requireDeposit: z.boolean().default(false),
    rolloverTimes: z.number({ invalid_type_error: "Rollover: informe um número" }).min(1, "Rollover mínimo de 1×").max(200, "Rollover máximo de 200×"),
    rolloverBase: z.enum(["BONUS", "DEPOSIT_BONUS"]).default("BONUS"),
    maxBet: optAmount(0.1, 100_000, "Aposta máxima"),
    maxConversion: optAmount(0.01, 10_000_000, "Teto de conversão"),
    validDays: z.number().int("Prazo: dias inteiros").min(1, "Prazo mínimo de 1 dia").max(365, "Prazo máximo de 365 dias"),
    maxPerPlayer: z.number().int().min(1, "Vezes por jogador: mínimo 1").max(1000).default(1),
    sortOrder: z.number().int().min(0).max(9999).default(0),
    gameIds: z.array(z.string().min(1)).min(1, "Escolha pelo menos um jogo").max(3000, "No máximo 3.000 jogos por campanha"),
  })
  .superRefine((c, ctx) => {
    if (c.trigger === "DEPOSIT" && c.bonusPercent == null) {
      ctx.addIssue({ code: "custom", path: ["bonusPercent"], message: "Informe o % de bônus sobre o depósito" });
    }
    if (c.trigger !== "DEPOSIT" && (c.bonusFixed == null || c.bonusFixed <= 0)) {
      ctx.addIssue({ code: "custom", path: ["bonusFixed"], message: "Informe o valor do bônus" });
    }
    if (c.trigger !== "DEPOSIT" && c.rolloverBase === "DEPOSIT_BONUS") {
      ctx.addIssue({ code: "custom", path: ["rolloverBase"], message: "Rollover sobre depósito + bônus só existe em campanha de depósito" });
    }
    if (c.startsAt && c.endsAt && new Date(c.endsAt) <= new Date(c.startsAt)) {
      ctx.addIssue({ code: "custom", path: ["endsAt"], message: "O fim precisa ser depois do início" });
    }
  });
export type CampaignInput = z.infer<typeof campaignInputSchema>;

export const incentiveIdSchema = z.object({ id: z.string().min(1).max(40) });

export const incentiveGrantSchema = z.object({
  campaignId: z.string().min(1).max(40),
  user: z.string().trim().min(3, "Informe o jogador (id, e-mail ou CPF)").max(120),
  amount: z.number().min(0.01, "Valor mínimo de R$ 0,01").max(1_000_000).optional(),
  note: z.string().trim().max(200).default(""),
});

export const incentiveCancelSchema = z.object({ note: z.string().trim().max(200).default("") });

export const incentiveGrantsQuery = z.object({
  status: z.enum(["ACTIVE", "COMPLETED", "EXPIRED", "CANCELLED", "LOST", "all"]).default("all"),
  campaignId: z.string().max(40).optional(),
  userId: z.string().max(40).optional(),
  q: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(5).max(100).default(25),
});

export const incentiveAutofillSchema = z.object({ providerSlug: z.string().trim().min(1).max(120) });
