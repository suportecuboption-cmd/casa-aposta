import { prisma } from "../lib/prisma.js";
import { secretHint } from "../services/install-config.js";

/**
 * Gateways de pagamento (Admin → Pagamentos → Gateways), guardados no BANCO (SiteSetting "payments").
 * Um gateway ativo por vez; sem nenhum ativo o site fica no modo manual (PIX simulado e a equipe aprova).
 * O painel nunca recebe segredo de volta — só se está definido e os 4 últimos caracteres.
 * Fica em memória para leitura síncrona; carregado quando o servidor sobe e trocado a cada gravação.
 */

const KEY = "payments";

export type GatewayKey = "swytchpay" | "bspay";
export const GATEWAY_KEYS: GatewayKey[] = ["swytchpay", "bspay"];
export const isGatewayKey = (k: unknown): k is GatewayKey => typeof k === "string" && (GATEWAY_KEYS as string[]).includes(k);

export interface GatewayField {
  key: string;
  label: string;
  secret: boolean;
  required: boolean;
  help?: string;
  placeholder?: string;
}

/** Campos de cada gateway — a tela de configuração é montada a partir daqui. */
export const GATEWAY_FIELDS: Record<GatewayKey, GatewayField[]> = {
  swytchpay: [
    { key: "apiKey", label: "API Key", secret: false, required: true, placeholder: "ak_live_… ou ak_test_…", help: "Painel da SwytchPay → Desenvolvedores → Chaves de API." },
    { key: "apiSecret", label: "API Secret", secret: true, required: true, placeholder: "sk_live_…", help: "Aparece uma única vez, quando a chave é criada." },
    { key: "webhookSecret", label: "Segredo do webhook", secret: true, required: true, help: "Desenvolvedores → Webhooks. Confere a assinatura de cada aviso de pagamento." },
  ],
  bspay: [
    { key: "clientId", label: "Client ID", secret: false, required: true, help: "Dashboard da BSPay → Credenciais (a credencial precisa estar ativada)." },
    { key: "clientSecret", label: "Client Secret", secret: true, required: true },
    {
      key: "webhookIps",
      label: "IPs dos avisos (webhooks)",
      secret: false,
      required: false,
      placeholder: "185.193.127.186, 2a0a:3840:1337:127::b9c1:7fba:1337",
      help: "A BSPay não assina os avisos: só aceitamos os IPs dela. Vazio = os IPs da documentação.",
    },
  ],
};

export interface PaymentsConfig {
  active: GatewayKey | null;
  publicBaseUrl: string; // URL pública do site (ex.: o túnel) — monta as URLs de webhook
  gateways: Record<GatewayKey, Record<string, string>>;
  updatedAt: string | null;
  updatedBy: string | null;
}

const defaults = (): PaymentsConfig => ({ active: null, publicBaseUrl: "", gateways: { swytchpay: {}, bspay: {} }, updatedAt: null, updatedBy: null });

let current: PaymentsConfig = defaults();
export const paymentsConfig = () => current;
export const gatewayCreds = (k: GatewayKey): Record<string, string> => current.gateways[k] ?? {};

/** Pura: lê o JSON gravado, completando com o padrão (só campos conhecidos, só texto). */
export function parsePayments(value: string | null | undefined): PaymentsConfig {
  const d = defaults();
  if (!value) return d;
  try {
    const j = JSON.parse(value);
    const gateways = { ...d.gateways };
    for (const k of GATEWAY_KEYS) {
      const src = j?.gateways?.[k];
      const out: Record<string, string> = {};
      if (src && typeof src === "object") for (const f of GATEWAY_FIELDS[k]) if (typeof src[f.key] === "string") out[f.key] = src[f.key];
      gateways[k] = out;
    }
    return {
      active: isGatewayKey(j?.active) ? j.active : null,
      publicBaseUrl: typeof j?.publicBaseUrl === "string" ? j.publicBaseUrl : "",
      gateways,
      updatedAt: typeof j?.updatedAt === "string" ? j.updatedAt : null,
      updatedBy: typeof j?.updatedBy === "string" ? j.updatedBy : null,
    };
  } catch {
    return d;
  }
}

export async function loadPaymentsConfig() {
  const row = await prisma.siteSetting.findUnique({ where: { key: KEY } });
  current = parsePayments(row?.value);
  return current;
}

/** Pura: todos os campos obrigatórios preenchidos. */
export function gatewayConfigured(k: GatewayKey, creds: Record<string, string> = gatewayCreds(k)): boolean {
  return GATEWAY_FIELDS[k].every((f) => !f.required || !!creds[f.key]?.trim());
}

/** Pura: aplica o formulário. Segredo em branco = mantém o atual; campo comum = substitui; clear = apaga tudo. */
export function mergeGatewayCreds(k: GatewayKey, cur: Record<string, string>, input: Record<string, unknown>, clear = false): Record<string, string> {
  if (clear) return {};
  const out = { ...cur };
  for (const f of GATEWAY_FIELDS[k]) {
    const v = input[f.key];
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (f.secret) {
      if (t) out[f.key] = t;
    } else out[f.key] = t;
  }
  return out;
}

/** Pura: URL pública sem barra no fim. */
export const normalizePublicBase = (u: string) => u.trim().replace(/\/+$/, "");

async function persist(next: PaymentsConfig, adminId: string, action: string, payload: Record<string, unknown>) {
  const cfg: PaymentsConfig = { ...next, updatedAt: new Date().toISOString(), updatedBy: adminId };
  const value = JSON.stringify(cfg);
  await prisma.siteSetting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } });
  current = cfg;
  await prisma.adminAuditLog.create({ data: { adminId, action, target: KEY, payload: JSON.stringify(payload) } });
  return cfg;
}

export function setActiveGateway(active: GatewayKey | null, adminId: string) {
  return persist({ ...current, active }, adminId, "PAYMENTS_GATEWAY_SELECT", { active });
}

export function setPublicBaseUrl(url: string, adminId: string) {
  const publicBaseUrl = normalizePublicBase(url);
  return persist({ ...current, publicBaseUrl }, adminId, "PAYMENTS_SETTINGS", { publicBaseUrl });
}

/**
 * Grava as credenciais de um gateway. A auditoria guarda só os NOMES dos campos alterados.
 * Se as credenciais do gateway ativo ficarem incompletas, o site volta ao modo manual.
 */
export function saveGatewayCreds(k: GatewayKey, input: Record<string, unknown>, clear: boolean, adminId: string) {
  const before = current.gateways[k] ?? {};
  const next = mergeGatewayCreds(k, before, input, clear);
  const changed = GATEWAY_FIELDS[k].map((f) => f.key).filter((f) => (next[f] ?? "") !== (before[f] ?? ""));
  const active = current.active === k && !gatewayConfigured(k, next) ? null : current.active;
  return persist({ ...current, active, gateways: { ...current.gateways, [k]: next } }, adminId, "PAYMENTS_GATEWAY_CONFIG", {
    gateway: k,
    changed,
    cleared: clear,
    deactivated: active !== current.active,
  });
}

/** Visão segura para o painel: segredos nunca saem (só se estão definidos e o final). */
export function publicPaymentsView(cfg: PaymentsConfig = current) {
  return {
    active: cfg.active,
    publicBaseUrl: cfg.publicBaseUrl,
    updatedAt: cfg.updatedAt,
    updatedBy: cfg.updatedBy,
    gateways: GATEWAY_KEYS.map((k) => ({
      key: k,
      configured: gatewayConfigured(k, cfg.gateways[k] ?? {}),
      fields: GATEWAY_FIELDS[k].map((f) => {
        const v = cfg.gateways[k]?.[f.key] ?? "";
        return f.secret ? { ...f, set: !!v, hint: secretHint(v) } : { ...f, value: v };
      }),
    })),
  };
}
