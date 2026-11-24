import { z } from "zod";
import { urlOrPath, imageUploadSchema } from "./common.js";

export const bannerPlacement = z.enum(["MAIN", "SIDE"]);

/** Query pública: lista banners ativos, opcionalmente por posição. */
export const bannerQuerySchema = z.object({
  placement: bannerPlacement.optional(),
});

export const createBannerSchema = z.object({
  placement: bannerPlacement.default("MAIN"),
  title: z.string().trim().max(120).optional(),
  subtitle: z.string().trim().max(240).optional(),
  imageUrl: urlOrPath.optional(),
  bgColor: z.string().trim().max(200).optional(),
  ctaText: z.string().trim().max(40).optional(),
  ctaLink: urlOrPath.optional(),
  sortOrder: z.coerce.number().int().min(0).max(9999).default(0),
  isActive: z.boolean().default(true),
});

export const updateBannerSchema = createBannerSchema.partial().refine(
  (v) => Object.keys(v).length > 0,
  { message: "Nada para atualizar" },
);

export const bannerUploadSchema = imageUploadSchema;

export type CreateBannerInput = z.infer<typeof createBannerSchema>;
export type UpdateBannerInput = z.infer<typeof updateBannerSchema>;
