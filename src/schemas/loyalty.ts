import { z } from "zod";

/* ───────── Nível VIP ───────── */

export const vipLevelSchema = z.object({
  name: z.string().trim().min(1, "Dê um nome ao nível").max(24, "Nome do nível: até 24 caracteres"),
  minWagered: z.number().min(0).max(100_000_000),
  reward: z.number().min(0, "O bônus não pode ser negativo").max(1_000_000),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Cor inválida").default("#8f9aab"),
  perks: z.string().trim().max(200).default(""),
});
export const vipConfigSchema = z.object({
  enabled: z.boolean(),
  levels: z.array(vipLevelSchema).min(1, "Cadastre pelo menos um nível").max(20),
});
export const vipClaimSchema = z.object({ level: z.string().trim().min(1).max(24) });

/* ───────── Coleções ───────── */

export const collectionsSettingsSchema = z.object({
  enabled: z.boolean(),
  packEvery: z.number().min(1, "Mínimo de R$ 1 por pacote").max(1_000_000),
  cardsPerPack: z.number().int().min(1).max(10),
});
export const collectionInputSchema = z.object({
  name: z.string().trim().min(1, "Dê um nome à coleção").max(60),
  description: z.string().trim().max(200).default(""),
  reward: z.number().min(0).max(1_000_000),
  active: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(9999).default(0),
  gameIds: z.array(z.string().min(1)).min(1, "Escolha pelo menos um jogo").max(60, "No máximo 60 cartas por coleção"),
});
export const collectionIdSchema = z.object({ id: z.string().min(1) });
export const gameSearchSchema = z.object({ q: z.string().trim().min(2, "Digite pelo menos 2 letras").max(60) });
export const autofillSchema = z.object({ providerSlug: z.string().trim().min(1).max(120), count: z.number().int().min(1).max(60) });
