import { prisma } from "../lib/prisma.js";

/**
 * Configuração de instalação guardada no BANCO (não no .env) e editada no admin em
 * Ajustes → Instalação. Hoje: credenciais da PlayFivers. O painel nunca devolve token nem segredo —
 * só se estão definidos e os 4 últimos caracteres. Fica em memória para leitura síncrona pelo
 * adaptador e pelos webhooks; é carregada quando o servidor sobe e trocada a cada gravação.
 */

const KEY = "install";
export const DEFAULT_PF_BASE = "https://api.playfivers.com";

export interface PlayfiversInstall {
  baseUrl: string;
  agentCode: string; // "Código do agente" — vem no webhook de transação (agent_code)
  agentToken: string; // "Token do agente" — usado no game_launch, agente e carteiras
  secretKey: string; // "Segredo do agente" — game_launch e agent_secret do webhook
  ipAllowlist: string; // IPs da PlayFivers autorizados a chamar os webhooks (vazio = qualquer IP)
}
export interface InstallConfig {
  playfivers: PlayfiversInstall;
  updatedAt: string | null;
  updatedBy: string | null;
}

const defaults = (): InstallConfig => ({
  playfivers: { baseUrl: DEFAULT_PF_BASE, agentCode: "", agentToken: "", secretKey: "", ipAllowlist: "" },
  updatedAt: null,
  updatedBy: null,
});

let current: InstallConfig = defaults();
export const installConfig = () => current;
export const pfInstall = () => current.playfivers;

/** Pura: lê o JSON gravado, completando o que faltar com o padrão. */
export function parseInstall(value: string | null | undefined): InstallConfig {
  const d = defaults();
  if (!value) return d;
  try {
    const j = JSON.parse(value);
    return { ...d, ...j, playfivers: { ...d.playfivers, ...(j?.playfivers ?? {}) } };
  } catch {
    return d;
  }
}

export async function loadInstallConfig() {
  const row = await prisma.siteSetting.findUnique({ where: { key: KEY } });
  current = parseInstall(row?.value);
  return current;
}

export interface PlayfiversInput {
  baseUrl?: string;
  agentCode?: string;
  agentToken?: string;
  secretKey?: string;
  ipAllowlist?: string;
  clearCredentials?: boolean;
}

/** Pura: lista de IPs em "a, b, c" (aceita vírgula, ponto e vírgula, espaço ou quebra de linha). */
export const normalizeIps = (s: string) =>
  [...new Set(s.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean))].join(", ");

/** Pura: itens que não parecem IP (v4 ou v6). */
export const invalidIps = (s: string) =>
  normalizeIps(s).split(", ").filter(Boolean).filter((ip) => !/^(\d{1,3}(\.\d{1,3}){3}|[0-9a-f:]*:[0-9a-f:.]*)$/i.test(ip));

/**
 * Pura: aplica o formulário. Token/segredo em branco = mantém o atual (o painel não os mostra);
 * clearCredentials apaga código, token e segredo.
 */
export function mergePlayfivers(cur: PlayfiversInstall, input: PlayfiversInput): PlayfiversInstall {
  if (input.clearCredentials) return { ...cur, agentCode: "", agentToken: "", secretKey: "" };
  return {
    baseUrl: (input.baseUrl?.trim() || cur.baseUrl || DEFAULT_PF_BASE).replace(/\/+$/, ""),
    agentCode: input.agentCode !== undefined ? input.agentCode.trim() : cur.agentCode,
    agentToken: input.agentToken?.trim() ? input.agentToken.trim() : cur.agentToken,
    secretKey: input.secretKey?.trim() ? input.secretKey.trim() : cur.secretKey,
    ipAllowlist: input.ipAllowlist !== undefined ? normalizeIps(input.ipAllowlist) : cur.ipAllowlist,
  };
}

/** Pura: dica do segredo sem revelar ("••••a1b2"). */
export const secretHint = (s: string) => (s ? `••••${s.slice(-4)}` : "");

export async function savePlayfiversInstall(input: PlayfiversInput, adminId: string) {
  const before = current.playfivers;
  const next = mergePlayfivers(before, input);
  const cfg: InstallConfig = { ...current, playfivers: next, updatedAt: new Date().toISOString(), updatedBy: adminId };
  const value = JSON.stringify(cfg);
  await prisma.siteSetting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } });
  current = cfg;
  // Auditoria registra só QUAIS campos mudaram — nunca os valores do token/segredo.
  const changed = (Object.keys(next) as (keyof PlayfiversInstall)[]).filter((k) => next[k] !== before[k]);
  await prisma.adminAuditLog.create({
    data: { adminId, action: "INSTALL_PLAYFIVERS_UPDATE", target: KEY, payload: JSON.stringify({ changed, cleared: !!input.clearCredentials }) },
  });
  return cfg;
}

/** Visão segura para o painel: sem token/segredo, só se estão definidos e o final. */
export function publicInstallView(cfg: InstallConfig = current) {
  const p = cfg.playfivers;
  return {
    playfivers: {
      baseUrl: p.baseUrl,
      agentCode: p.agentCode,
      ipAllowlist: p.ipAllowlist,
      agentTokenSet: !!p.agentToken,
      agentTokenHint: secretHint(p.agentToken),
      secretKeySet: !!p.secretKey,
      secretKeyHint: secretHint(p.secretKey),
      configured: !!(p.agentToken && p.secretKey),
    },
    updatedAt: cfg.updatedAt,
    updatedBy: cfg.updatedBy,
  };
}
