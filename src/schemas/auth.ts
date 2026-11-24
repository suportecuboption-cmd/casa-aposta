import { z } from "zod";
import { isValidCpf, normalizeCpf, isValidPhoneBR, normalizePhone } from "../lib/br.js";

export const registerSchema = z.object({
  displayName: z.string().trim().min(3, "Nome de usuário deve ter ao menos 3 caracteres").max(30, "Máximo de 30 caracteres"),
  email: z.string().trim().toLowerCase().email("E-mail inválido"),
  cpf: z.string().refine(isValidCpf, "CPF inválido").transform(normalizeCpf),
  phone: z.string().refine(isValidPhoneBR, "Celular inválido").transform(normalizePhone),
  password: z.string().min(8, "Senha deve ter ao menos 8 caracteres"),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
