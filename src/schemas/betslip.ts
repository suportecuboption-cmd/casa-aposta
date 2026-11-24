import { z } from "zod";

export const BETSLIP_STAKE_LIMITS = { min: 1, max: 10_000 } as const;
export const MAX_SELECTIONS = 20;

export const outcomeSchema = z.enum(["home", "draw", "away"]);

export const selectionInputSchema = z.object({
  eventId: z.string().min(1),
  market: z.literal("1X2").default("1X2"),
  selection: outcomeSchema,
});

export const placeBetslipSchema = z
  .object({
    stake: z
      .number({ invalid_type_error: "stake deve ser numérico" })
      .min(BETSLIP_STAKE_LIMITS.min, `Aposta mínima é ${BETSLIP_STAKE_LIMITS.min}`)
      .max(BETSLIP_STAKE_LIMITS.max, `Aposta máxima é ${BETSLIP_STAKE_LIMITS.max}`),
    selections: z.array(selectionInputSchema).min(1).max(MAX_SELECTIONS),
    clientRef: z.string().min(1).max(80).optional(),
  })
  .superRefine((v, ctx) => {
    const ids = v.selections.map((s) => s.eventId);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Seleções do mesmo evento não podem compor uma acumulada",
        path: ["selections"],
      });
    }
  });

export const settleEventSchema = z.object({ outcome: outcomeSchema });

export type PlaceBetslipInput = z.infer<typeof placeBetslipSchema>;
