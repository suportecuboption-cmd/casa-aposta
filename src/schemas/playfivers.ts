import { z } from "zod";

/** Webhook de saldo (POST /webhook): { type: "BALANCE", user_code }. */
export const pfBalanceWebhookSchema = z
  .object({
    type: z.string().optional(),
    user_code: z.string().min(1, "user_code obrigatório"),
  })
  .passthrough();

/** Corpo do webhook de transação (POST /api/webhook) — parte de topo. */
export const pfTxnTopSchema = z
  .object({
    type: z.enum(["WinBet", "Refund"]),
    user_code: z.string().min(1, "user_code obrigatório"),
    game_type: z.string().optional(),
    agent_code: z.string().optional(),
    agent_secret: z.string().optional(),
  })
  .passthrough();

/**
 * Objeto da transação (vem em `slot`, mas pode variar pelo game_type — ler como dinâmico).
 * `bet`/`win` já chegam na moeda do agente.
 */
export const pfSlotSchema = z
  .object({
    txn_id: z.string().min(1, "txn_id obrigatório"),
    round_id: z.string().optional(),
    game_code: z.string().optional(),
    provider_code: z.string().optional(),
    bet: z.coerce.number().optional(),
    win: z.coerce.number().optional(),
    txn_type: z.string().optional(),
  })
  .passthrough();

export type PfTxnTop = z.infer<typeof pfTxnTopSchema>;
export type PfSlot = z.infer<typeof pfSlotSchema>;

/* ── admin: config do agente e rodadas grátis ── */

export const pfAgentUpdateSchema = z.object({
  rtp: z.coerce.number().int().min(0, "RTP de 0 a 100").max(100, "RTP de 0 a 100"),
  limit_enable: z.boolean(),
  limit_amount: z.coerce.number().min(0, "Valor inválido").max(100_000_000, "Valor alto demais"),
  limit_hours: z.coerce.number().int().min(1, "Mínimo de 1 hora").max(8760, "Máximo de 8760 horas"),
  bonus_enable: z.boolean(),
});

export const pfFreeBonusGrantSchema = z.object({
  user_code: z.string().trim().min(1, "Informe o jogador"),
  game_code: z.string().trim().min(1, "Informe o jogo"),
  rounds: z.coerce.number().int().min(1, "No mínimo 1 rodada").max(23, "No máximo 23 rodadas"),
});

export type PfAgentUpdate = z.infer<typeof pfAgentUpdateSchema>;
export type PfFreeBonusGrant = z.infer<typeof pfFreeBonusGrantSchema>;
