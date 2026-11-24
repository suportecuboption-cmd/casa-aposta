/** Utilidades compartilhadas pelos gateways de pagamento (HTTP, valores, chave PIX, IP). */

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status = 502,
    readonly code = "GATEWAY_ERROR",
  ) {
    super(message);
  }
}

export interface GwResponse {
  status: number;
  ok: boolean;
  json: any;
}

export async function gwFetch(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; timeoutMs?: number },
): Promise<GwResponse> {
  let res: Response;
  try {
    res = await fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: AbortSignal.timeout(init.timeoutMs ?? 15_000) });
  } catch (e) {
    throw new GatewayError(`Sem resposta do gateway (${e instanceof Error ? e.message : "rede"})`, 504, "GATEWAY_TIMEOUT");
  }
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  return { status: res.status, ok: res.ok, json };
}

/** Pura: erro no formato { error: { code, message } } (ou { message }) → GatewayError legível. */
export function gatewayErrorFrom(json: any, fallback: string): GatewayError {
  const e = json?.error;
  const msg =
    typeof e?.message === "string" && e.message.trim()
      ? e.message.trim()
      : typeof json?.message === "string" && json.message.trim()
        ? json.message.trim()
        : fallback;
  const code = typeof e?.code === "string" && e.code ? e.code : "GATEWAY_ERROR";
  return new GatewayError(code !== "GATEWAY_ERROR" ? `${msg} (${code})` : msg, 502, code);
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
export const toCents = (n: number) => Math.round(n * 100);
export const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" && v.trim() ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
};
export const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : undefined;

export type GatewayKeyType = "cpf" | "cnpj" | "email" | "phone" | "random";

/** Pura: chave PIX do nosso cadastro (CPF | CNPJ | CELULAR | EMAIL | ALEATORIA) no formato dos gateways. */
export function pixKeyFor(type: string | null | undefined, key: string | null | undefined): { key: string; type: GatewayKeyType } {
  const k = (key ?? "").trim();
  const digits = k.replace(/\D/g, "");
  switch ((type ?? "").toUpperCase()) {
    case "CPF":
      return { key: digits, type: "cpf" };
    case "CNPJ":
      return { key: digits, type: "cnpj" };
    case "EMAIL":
      return { key: k.toLowerCase(), type: "email" };
    case "CELULAR":
    case "PHONE":
    case "TELEFONE": {
      // formato do DICT: +55 + DDD + número (o DDD 55 também existe, por isso o teste de tamanho)
      const d = digits.startsWith("55") && digits.length >= 12 ? digits : `55${digits}`;
      return { key: `+${d}`, type: "phone" };
    }
    default:
      return { key: k, type: "random" };
  }
}

export const normIp = (ip: string) => ip.trim().toLowerCase().replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, "$1");

/**
 * Pura: IP real de quem chamou. Atrás do túnel (cloudflared/ngrok) o pedido chega de localhost e o
 * IP verdadeiro vem no cabeçalho do túnel; fora dele vale o IP da conexão.
 */
export function clientIp(reqIp: string, headers: Record<string, string | string[] | undefined>): string {
  const first = (v: string | string[] | undefined) => ((Array.isArray(v) ? v[0] : v) ?? "").split(",")[0].trim();
  if (/^(127\.|::1$|::ffff:127\.)/.test(reqIp)) {
    const fwd = first(headers["cf-connecting-ip"]) || first(headers["x-forwarded-for"]);
    if (fwd) return normIp(fwd);
  }
  return normIp(reqIp);
}
