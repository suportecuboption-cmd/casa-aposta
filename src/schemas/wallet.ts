import { z } from "zod";

/**
 * Limites de carteira (BRL). Fonte única de verdade — usado pelas rotas,
 * pelo OpenAPI e pelos testes unitários.
 */
export const WALLET_LIMITS = {
  deposit: { min: 5, max: 50_000 },
  withdraw: { min: 20, max: 50_000 },
} as const;

export const depositSchema = z.object({
  amount: z
    .number({ invalid_type_error: "amount deve ser numérico" })
    .min(WALLET_LIMITS.deposit.min, `Depósito mínimo é ${WALLET_LIMITS.deposit.min}`)
    .max(WALLET_LIMITS.deposit.max, `Depósito máximo é ${WALLET_LIMITS.deposit.max}`),
  // Campanha de incentivo escolhida no depósito (o bônus entra quando o PIX cair).
  campaignId: z.string().min(1).max(40).optional(),
});

export const withdrawSchema = z.object({
  amount: z
    .number({ invalid_type_error: "amount deve ser numérico" })
    .min(WALLET_LIMITS.withdraw.min, `Saque mínimo é ${WALLET_LIMITS.withdraw.min}`)
    .max(WALLET_LIMITS.withdraw.max, `Saque máximo é ${WALLET_LIMITS.withdraw.max}`),
  // Chave PIX de destino (opcional: sem ela, usa o CPF do cadastro).
  pixKey: z.string().trim().min(3, "Chave PIX inválida").max(140).optional(),
  pixKeyType: z.enum(["CPF", "CELULAR", "EMAIL", "ALEATORIA"]).optional(),
});

export type DepositInput = z.infer<typeof depositSchema>;
export type WithdrawInput = z.infer<typeof withdrawSchema>;
