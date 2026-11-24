import { z } from "zod";

/** Ajustes → Instalação: credenciais da PlayFivers (token/segredo em branco = mantém o atual). */
export const installPlayfiversSchema = z.object({
  baseUrl: z
    .string()
    .trim()
    .max(200)
    .refine((u) => u === "" || /^https?:\/\/[^\s/?#]+[^\s]*$/i.test(u), "URL inválida (use https://…)")
    .optional(),
  agentCode: z.string().trim().max(120).optional(),
  agentToken: z.string().trim().max(500).optional(),
  secretKey: z.string().trim().max(500).optional(),
  ipAllowlist: z.string().trim().max(2000).optional(),
  clearCredentials: z.boolean().optional(),
});
