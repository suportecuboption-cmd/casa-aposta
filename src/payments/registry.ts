import { bspay } from "./bspay.js";
import { swytchpay } from "./swytchpay.js";
import { gatewayConfigured, paymentsConfig, type GatewayKey } from "./config.js";
import type { PixGateway, PixPayer } from "./types.js";

/** Gateways disponíveis. Para adicionar outro: um adaptador + seus campos em config.ts. */
export const GATEWAYS: Record<GatewayKey, PixGateway> = { swytchpay, bspay };

export const webhookPath = (k: GatewayKey) => `/payments/webhook/${k}`;

/** Gateway ativo e com credenciais completas — ou null (modo manual). */
export function activeGateway(): PixGateway | null {
  const k = paymentsConfig().active;
  return k && gatewayConfigured(k) ? GATEWAYS[k] : null;
}

/** URL de webhook enviada ao gateway: só https (os gateways recusam http); "" se a URL pública não foi definida. */
export function webhookUrlFor(k: GatewayKey): string {
  const base = paymentsConfig().publicBaseUrl;
  return /^https:\/\//i.test(base) ? `${base}${webhookPath(k)}` : "";
}

/** Dados do pagador/recebedor a partir do cadastro do jogador. */
export function payerOf(u: { email: string; displayName: string | null; cpf: string | null }): PixPayer {
  return {
    name: u.displayName?.trim() || u.email.split("@")[0],
    document: u.cpf ? u.cpf.replace(/\D/g, "") : undefined,
    email: u.email,
  };
}
