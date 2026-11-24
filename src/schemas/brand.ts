import { z } from "zod";

/** Altura da imagem da logo no topo do site (px). */
export const LOGO_HEIGHT = { min: 18, max: 64, default: 32 } as const;

// Só imagem enviada pelo botão do painel (fica em /uploads/); null remove.
const brandImage = z
  .string()
  .trim()
  .regex(/^\/uploads\/[A-Za-z0-9._-]+$/, "Envie a imagem pelo botão do painel")
  .nullable();
const word = z.string().trim().max(24, "Logo em texto: até 24 caracteres em cada parte");

/** Ajustes → Marca (campo ausente = mantém o atual). */
export const brandSchema = z
  .object({
    name: z.string().trim().min(1, "Informe o nome do site").max(40, "Nome do site: até 40 caracteres"),
    wordA: word,
    wordB: word,
    logoUrl: brandImage,
    logoDarkUrl: brandImage,
    iconUrl: brandImage,
    logoHeight: z.number().int().min(LOGO_HEIGHT.min).max(LOGO_HEIGHT.max),
    // botão "Suporte" do menu do celular (WhatsApp, Telegram, página de atendimento); vazio = sem botão
    supportUrl: z.string().trim().max(300).refine((u) => u === "" || /^https?:\/\/[^\s"'<>]+$/i.test(u), "Link do suporte inválido (use https://…)"),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "Nada para atualizar" });

/** Envio da logo ou do ícone (data URL; SVG vira PNG no servidor). */
export const brandUploadSchema = z.object({
  kind: z.enum(["logo", "icon"]),
  dataUrl: z.string().regex(/^data:image\/(png|jpe?g|webp|gif|avif|svg\+xml);base64,/i, "Envie uma imagem PNG, JPG, WEBP, GIF, AVIF ou SVG"),
});

export type BrandInput = z.infer<typeof brandSchema>;
