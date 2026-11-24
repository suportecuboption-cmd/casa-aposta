import { z } from "zod";
import { urlOrPath } from "./common.js";

export const patchProviderSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    logoUrl: urlOrPath.optional(), // "" remove o logo
  })
  .refine((v) => v.name !== undefined || v.logoUrl !== undefined, {
    message: "Nada para atualizar",
  });

export type PatchProviderInput = z.infer<typeof patchProviderSchema>;
