import { z } from "zod";

/** Ajustes da faixa "Grandes vitórias recentes" (admin → Site → Vitórias recentes). */
export const winsFeedConfigSchema = z
  .object({
    enabled: z.boolean(),
    minAmount: z
      .number({ invalid_type_error: "Informe o prêmio mínimo" })
      .min(0, "O prêmio mínimo não pode ser negativo")
      .max(1_000_000, "Valor alto demais")
      .multipleOf(0.01, "Use no máximo 2 casas decimais"),
    casino: z.boolean(),
    sports: z.boolean(),
    maxAgeDays: z.number().int().min(1, "Mínimo de 1 dia").max(90, "Máximo de 90 dias"),
    limit: z.number().int().min(4, "Mostre pelo menos 4").max(30, "Máximo de 30"),
  })
  .refine((c) => c.casino || c.sports, { message: "Escolha cassino, esportes ou os dois", path: ["casino"] });

export type WinsFeedConfig = z.infer<typeof winsFeedConfigSchema>;
