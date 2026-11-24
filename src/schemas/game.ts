import { z } from "zod";
import { urlOrPath } from "./common.js";

const slug = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, "Informe o slug")
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug: use letras minúsculas, números e hífens (ex.: fortune-tiger)");

const fields = {
  providerSlug: z.string().trim().min(1, "Escolha o provedor"),
  slug,
  name: z.string().trim().min(1, "Informe o nome").max(80),
  // "slots", "live", "mesa", "crash" ou outra categoria livre
  category: z.string().trim().toLowerCase().min(1, "Escolha a categoria").max(40),
  imageUrl: urlOrPath, // "" remove a imagem
  hasDemo: z.boolean(),
  isLive: z.boolean(),
  isActive: z.boolean(),
  featured: z.boolean(),
  sortOrder: z.number().int().min(0).max(100000),
};

export const createGameSchema = z.object({
  ...fields,
  imageUrl: fields.imageUrl.optional(),
  hasDemo: fields.hasDemo.default(false),
  isLive: fields.isLive.default(false),
  isActive: fields.isActive.default(true),
  featured: fields.featured.default(false),
  sortOrder: fields.sortOrder.default(0),
});

// Reordenar "Em alta": lista de ids na ordem desejada (sortOrder = índice).
export const gameOrderSchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(5000) });
// Marcar/desmarcar "Em alta".
export const gameFeaturedSchema = z.object({ featured: z.boolean() });
// Ativar/desativar todos os jogos de um provedor (ex.: escolher entre a versão "oficial" e a "clone").
export const gameBulkActiveSchema = z.object({ providerSlug: z.string().trim().min(1).max(80), isActive: z.boolean() });
// Carteiras da PlayFivers habilitadas na conta (escolha manual enquanto o token não foi configurado).
export const casinoWalletsSchema = z.object({ enabled: z.array(z.string().trim().min(1).max(120)).max(50) });

export const updateGameSchema = z
  .object(fields)
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "Nada para atualizar" });

export type CreateGameInput = z.infer<typeof createGameSchema>;
export type UpdateGameInput = z.infer<typeof updateGameSchema>;
