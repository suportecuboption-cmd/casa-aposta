import { z } from "zod";
import { Role } from "@prisma/client";

export const patchUserSchema = z
  .object({
    isActive: z.boolean().optional(),
    role: z.nativeEnum(Role).optional(),
  })
  .refine((v) => v.isActive !== undefined || v.role !== undefined, {
    message: "Nada para atualizar",
  });

export const pixQuerySchema = z.object({
  status: z.enum(["PENDING", "PAID", "FAILED", "EXPIRED"]).optional(),
});

export const idParamSchema = z.object({ id: z.string().min(1) });

export type PatchUserInput = z.infer<typeof patchUserSchema>;
