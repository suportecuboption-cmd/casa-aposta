import { z } from "zod";

const gatewayKey = z.enum(["swytchpay", "bspay"]);

// Um clique: escolhe o gateway ativo (null = modo manual).
export const paymentsActiveSchema = z.object({ active: gatewayKey.nullable() });

// URL pública do site (monta as URLs de webhook que os gateways chamam).
export const paymentsSettingsSchema = z.object({
  publicBaseUrl: z
    .string()
    .trim()
    .max(200)
    .refine((u) => u === "" || /^https?:\/\/[^\s/?#]+[^\s]*$/i.test(u), "URL inválida (use https://…)"),
});

// Credenciais de um gateway: valores por campo (segredo em branco mantém o atual) ou clear.
export const gatewayConfigSchema = z.object({
  values: z.record(z.string(), z.string().max(500)).default({}),
  clear: z.boolean().optional(),
});

export const gatewayParamSchema = z.object({ key: gatewayKey });
