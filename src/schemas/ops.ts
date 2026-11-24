import { z } from "zod";

/** Validação das telas de Operação (listas, ficha do jogador, proteção, risco e faturas). */

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data no formato AAAA-MM-DD");
const page = z.coerce.number().int().min(1).max(100_000).default(1);
const size = z.coerce.number().int().min(5).max(100).default(25);
const dir = z.enum(["asc", "desc"]).default("desc");
const search = z.string().trim().max(120).optional();
const money = (max = 10_000_000) => z.number({ invalid_type_error: "Informe um valor" }).positive("O valor deve ser maior que zero").max(max, "Valor alto demais");

export const opsPixQuery = z.object({
  kind: z.enum(["DEPOSIT", "WITHDRAW"]),
  from: ymd.optional(),
  to: ymd.optional(),
  status: z.enum(["PENDING", "PAID", "FAILED", "EXPIRED"]).optional(),
  gateway: z.string().trim().max(40).optional(),
  method: z.string().trim().max(20).optional(),
  currency: z.string().trim().max(5).optional(),
  q: search,
  tab: z.enum(["all", "action"]).default("all"),
  page, size,
  sort: z.enum(["date", "amount"]).default("date"),
  dir,
});

export const opsUsersQuery = z.object({
  q: search,
  account: z.enum(["all", "active", "blocked", "test", "restricted"]).default("all"),
  kyc: z.enum(["all", "none", "verified"]).default("all"),
  activity: z.enum(["all", "active30", "inactive30"]).default("all"),
  signup: z.enum(["all", "today", "7d", "30d"]).default("all"),
  page, size,
  sort: z.enum(["name", "createdAt"]).default("createdAt"),
  dir,
});

export const testAccountSchema = z.object({
  name: z.string().trim().min(3, "Nome com ao menos 3 caracteres").max(60),
  email: z.string().trim().toLowerCase().email("E-mail inválido"),
  password: z.string().min(8, "Senha com ao menos 8 caracteres").max(100),
  initialBalance: z.number().min(0).max(1_000_000).default(0),
});

export const rangeQuery = z.object({ from: ymd.optional(), to: ymd.optional(), q: search, page, size });
export const userPixQuery = rangeQuery.extend({ kind: z.enum(["DEPOSIT", "WITHDRAW"]), status: z.enum(["PENDING", "PAID", "FAILED", "EXPIRED"]).optional() });
export const ledgerQuery = rangeQuery.extend({ category: z.enum(["all", "deposits", "withdrawals", "casino", "sports", "adjustments", "bonus"]).default("all") });

export const restrictionSchema = z.object({
  kind: z.enum(["SELF_EXCLUSION", "SUSPENSION", "MANUAL_BLOCK"]),
  reason: z.string().trim().min(3, "Informe o motivo").max(200),
  detail: z.string().trim().max(500).nullable().optional(),
  days: z.number().int().min(1).max(3650).nullable().optional(), // null = sem prazo definido
  scope: z.enum(["GAMING", "TOTAL"]).optional(),
});
export const restrictionEditSchema = z.object({ days: z.number().int().min(1, "Mínimo de 1 dia").max(3650).nullable() });
export const revokeSchema = z.object({ note: z.string().trim().min(3, "Explique por que está retirando").max(200) });
// Autoexclusão pedida pelo próprio jogador (null = sem prazo definido).
export const selfExclusionSchema = z.object({ days: z.number().int().min(1, "Mínimo de 1 dia").max(3650).nullable() });

export const rgLimitSchema = z.object({
  kind: z.enum(["DEPOSIT", "BET", "LOSS", "SESSION"]),
  period: z.enum(["DAY", "WEEK", "MONTH"]),
  amount: money(),
});

const optMoney = money().nullable();
export const withdrawLimitsSchema = z.object({
  maxPerWithdrawal: optMoney,
  dailyAmount: optMoney,
  dailyCount: z.number().int().min(1).max(1000).nullable(),
  minIntervalMin: z.number().int().min(1).max(10_080).nullable(),
});
export const testFlagSchema = z.object({ isTest: z.boolean() });

export const rankingPlayersQuery = z.object({ metric: z.enum(["balance", "deposits", "withdrawals"]).default("balance"), from: ymd.optional(), to: ymd.optional(), q: search });
export const rankingGamesQuery = z.object({ by: z.enum(["game", "provider"]).default("game"), order: z.enum(["desc", "asc"]).default("desc"), from: ymd.optional(), to: ymd.optional() });

export const riskQuery = z.object({
  scope: z.enum(["all", "casino", "sports"]).default("all"),
  from: ymd.optional(),
  to: ymd.optional(),
  provider: z.string().trim().max(40).optional(),
  game: z.string().trim().max(40).optional(),
});
export const riskResultsQuery = riskQuery.extend({ page, size, sort: z.enum(["net", "turnover"]).default("net"), dir });
export const riskAlertsSchema = z.object({ bigWinAmount: money().nullable() });

export const restrictionsQuery = z.object({
  type: z.enum(["all", "SELF_EXCLUSION", "MANUAL_BLOCK", "SUSPENSION"]).default("all"),
  action: z.enum(["all", "active", "changed", "revoked", "expired"]).default("all"),
  from: ymd.optional(),
  to: ymd.optional(),
  q: search,
  page,
  size: z.coerce.number().int().min(5).max(100).default(50),
});

export const adjustmentsQuery = rangeQuery.extend({ direction: z.enum(["all", "credit", "debit"]).default("all") });

export const invoiceMonthParam = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Mês no formato AAAA-MM") });
export const invoicePaymentSchema = z.object({ amount: money(100_000_000), paidAt: ymd, note: z.string().trim().max(200).optional() });
export const invoiceParamsSchema = z.object({
  issuer: z.string().trim().min(2, "Informe o emissor").max(60),
  defaultPct: z.number().min(0).max(100).nullable(),
  providers: z.record(z.string().trim().min(1).max(60), z.number().min(0, "% de 0 a 100").max(100, "% de 0 a 100")),
});
