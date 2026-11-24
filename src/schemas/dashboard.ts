import { z } from "zod";

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data no formato AAAA-MM-DD");

/**
 * Filtros do dashboard (mesmos controles do Axio):
 *  mode "native" (Nativa) = só operações na moeda escolhida, sem conversão;
 *  mode "usd" (USD Geral)  = todas as moedas consolidadas e convertidas para `cur`.
 */
export const dashQuerySchema = z.object({
  from: ymd.optional(),
  to: ymd.optional(),
  mode: z.enum(["native", "usd"]).default("native"),
  cur: z.enum(["BRL", "USD"]).default("BRL"),
});
export type DashQuery = z.infer<typeof dashQuerySchema>;

/** Parâmetros do dashboard editáveis no admin (Ajustes → Parâmetros). */
export const walletParamSchema = z.object({
  ggrPct: z.number({ invalid_type_error: "Informe o GGR %" }).min(0, "GGR % de 0 a 100").max(100, "GGR % de 0 a 100").nullable(),
  minBalance: z.number({ invalid_type_error: "Informe o saldo mínimo" }).min(0, "Saldo mínimo não pode ser negativo").max(10_000_000, "Valor alto demais"),
});

export const dashboardParamsSchema = z.object({
  // Cotação: quantos reais vale US$ 1. Sem cotação, os modos em dólar ficam indisponíveis.
  usdBrlRate: z.number({ invalid_type_error: "Informe a cotação" }).positive("A cotação deve ser maior que zero").max(100, "Cotação alta demais").nullable(),
  // Painel do agregador, aberto pelo botão "Adicionar saldo" das carteiras.
  panelUrl: z.union([z.literal(""), z.string().trim().url("URL inválida").max(500)]),
  // Por carteira do agregador (nome exatamente como a PlayFivers devolve em /balances).
  wallets: z.record(z.string().trim().min(1).max(80), walletParamSchema),
});
export type DashboardParams = z.infer<typeof dashboardParamsSchema>;
export type WalletParam = z.infer<typeof walletParamSchema>;
