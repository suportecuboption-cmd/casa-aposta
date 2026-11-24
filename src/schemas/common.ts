import { z } from "zod";

/** URL http(s) ou caminho local começando com "/" (string vazia = limpar o campo). */
export const urlOrPath = z
  .string()
  .trim()
  .max(2048)
  .refine(
    (v) => v === "" || /^(https?:\/\/|\/)/.test(v),
    "Deve ser uma URL http(s) ou um caminho começando com /",
  );

/** Upload de imagem: data URL base64 vinda do admin (sem dependência de multipart). */
export const imageUploadSchema = z.object({
  dataUrl: z
    .string()
    .regex(/^data:image\/(png|jpe?g|webp|gif|avif);base64,/, "Envie uma imagem válida"),
  filename: z.string().trim().max(120).optional(),
});
