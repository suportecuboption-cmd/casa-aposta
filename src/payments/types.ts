import type { GatewayKey } from "./config.js";

/** Contrato comum dos gateways de pagamento PIX (cash-in, cash-out e webhooks). */

export interface PixPayer {
  name: string;
  document?: string; // CPF/CNPJ só com dígitos
  email?: string;
}

export interface CreateDepositInput {
  orderId: string; // nosso PixOrder.id — vai como external_id (idempotência no gateway)
  amount: number; // em reais
  payer: PixPayer;
  postbackUrl?: string;
}
export interface CreateDepositResult {
  gatewayTxId: string;
  pixCopy: string; // código "copia e cola" (EMV)
  expiresAt?: string;
  fee?: number; // taxa do gateway em reais
}

export interface CreatePayoutInput {
  orderId: string;
  amount: number; // em reais
  pixKey: string;
  pixKeyType: string; // do nosso cadastro: CPF | CNPJ | CELULAR | EMAIL | ALEATORIA
  name?: string;
  postbackUrl?: string;
}
export interface CreatePayoutResult {
  gatewayTxId: string;
}

/** O que um aviso (webhook) do gateway manda fazer com o pedido. */
export type WebhookEvent =
  | { kind: "deposit_paid"; orderId?: string; gatewayTxId?: string; amount?: number; fee?: number }
  | { kind: "deposit_expired"; orderId?: string; gatewayTxId?: string }
  | { kind: "payout_paid"; orderId?: string; gatewayTxId?: string; fee?: number }
  | { kind: "payout_failed"; orderId?: string; gatewayTxId?: string; reason: string }
  | { kind: "ignored"; event: string };

export interface WebhookRequest {
  ip: string; // IP real do remetente (já resolvido atrás do túnel)
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
}
export type Verify = { ok: true } | { ok: false; reason: string };

export interface PixGateway {
  key: GatewayKey;
  name: string;
  site: string;
  /** Como cadastrar o webhook no painel do gateway (texto da tela de configuração). */
  webhookHelp: string;
  /** Saldo disponível em reais — usado no "Testar conexão". */
  balance(): Promise<number | null>;
  createDeposit(i: CreateDepositInput): Promise<CreateDepositResult>;
  createPayout(i: CreatePayoutInput): Promise<CreatePayoutResult>;
  verifyWebhook(r: WebhookRequest): Verify;
  parseWebhook(body: unknown): WebhookEvent;
}
