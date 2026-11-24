import type { CasinoAdapter, ExternalGame, LaunchOptions } from "../types.js";
import { AppError } from "../../lib/errors.js";
import { pfInstall, DEFAULT_PF_BASE } from "../../services/install-config.js";

/**
 * Agregador PlayFivers (https://api.playfivers.com/docs/api).
 * Modelo seamless: nós somos a fonte de verdade do saldo; a PlayFivers chama os nossos
 * webhooks (/webhook e /api/webhook) para ler o saldo e aplicar aposta/ganho/estorno.
 * Aqui ficam só as chamadas de saída (catálogo e launch) — a carteira está em services/playfivers.ts.
 */

// Credenciais vêm do banco (admin → Ajustes → Instalação), não do .env.
const BASE = () => (pfInstall().baseUrl || DEFAULT_PF_BASE).replace(/\/+$/, "");
const TOKEN = () => pfInstall().agentToken;
const SECRET = () => pfInstall().secretKey;

const slugify = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** Chave do jogo no nosso banco: "<provedor>:<game_code>" (o game_code sozinho se repete entre provedores). */
export const playfiversKey = (providerName: string, gameCode: string) => `${slugify(providerName) || "playfivers"}:${gameCode}`;

// A PlayFivers não manda categoria: deduzimos pelo provedor e pelo nome (regras conferidas no
// catálogo real de 8,1 mil jogos). LIVE22 apesar do nome é de slots; DIGITAIN é sportsbook.
const LIVE_PROVIDER = /\bLIVE\b|EVOLUTION|EZUGI|WINFINITY|LIVE88/i;
const CRASH_PROVIDER = /SPRIBE|CRASH GAMES|AVIATRIX|TURBO GAMES/i;
const SPORTS_PROVIDER = /DIGITAIN/i;
const CRASH_NAME = /aviator|crash|mines|plinko|spaceman|jetx|aviatrix/i;
const TABLE_NAME = /roulette|roleta|blackjack|baccarat|bacar[aá]|poker|hold.?em|sic ?bo|dragon ?tiger|andar ?bahar|teen ?patti|craps/i;

/** Categoria e "ao vivo" a partir do provedor e do nome do jogo. Pura (testável). */
export function inferCategory(providerName: string, gameName: string): { category: string; isLive: boolean } {
  if (SPORTS_PROVIDER.test(providerName)) return { category: "sportsbook", isLive: false };
  if (LIVE_PROVIDER.test(providerName) && !/LIVE22/i.test(providerName)) return { category: "live", isLive: true };
  if (CRASH_PROVIDER.test(providerName) || CRASH_NAME.test(gameName)) return { category: "crash", isLive: false };
  if (TABLE_NAME.test(gameName)) return { category: "mesa", isLive: false };
  return { category: "slots", isLive: false };
}

/**
 * Converte um item cru de /api/v2/games no nosso ExternalGame. Pura (testável).
 * O game_code se repete entre provedores (ex.: "126"), então a chave é "<provedor>:<game_code>";
 * o código cru e o nome do provedor como a PlayFivers conhece vão em code/providerRaw (usados no launch).
 */
export function mapPlayfiversGame(raw: any, logos?: Map<string, string | null>, wallets?: Map<string, string | null>): ExternalGame {
  const providerName = String(raw?.provider?.name ?? "").trim() || "PlayFivers";
  const providerSlug = slugify(providerName) || "playfivers";
  const code = String(raw?.game_code ?? "").trim();
  const name = String(raw?.name ?? "").trim() || code || "Jogo";
  const { category, isLive } = inferCategory(providerName, name);
  return {
    externalId: code ? playfiversKey(providerName, code) : "",
    code,
    name,
    providerSlug,
    providerName,
    providerRaw: providerName,
    providerLogo: logos?.get(providerSlug) ?? null,
    providerWallet: wallets?.get(providerSlug) ?? null,
    category,
    isLive,
    imageUrl: raw?.image_url ?? null,
    hasDemo: false, // o game_launch da PlayFivers não tem modo demo
    original: Boolean(raw?.original),
    active: raw?.status !== false && raw?.status !== 0,
  };
}

async function pfJson(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${BASE()}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const json = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, json };
}

export interface PlayfiversAgentConfig {
  rtp: number;
  limit_enable: boolean;
  limit_amount: number;
  limit_hours: number;
  bonus_enable: boolean;
}
export interface PlayfiversFreeBonus {
  id: number;
  game_id?: string;
  game_name?: string;
  player_id?: string;
  rounds?: number;
  total_rounds?: number;
  status?: string;
  created_at?: string;
}

/** Erro vindo da PlayFivers preservando o status quando é de cliente (404/409/422). */
function pfError(status: number, msg: unknown, fallback: string): AppError {
  // a PlayFivers às vezes devolve msg como objeto (ex.: no /agent) — só usa se for texto.
  const text = typeof msg === "string" && msg.trim() ? msg : fallback;
  const code = status >= 400 && status < 500 ? status : 502;
  return new AppError(text, code, "PLAYFIVERS_ERROR");
}

/** Adaptador PlayFivers + chamadas administrativas extras (agente e rodadas grátis). */
export const playfiversAdapter: CasinoAdapter & {
  getAgent(): Promise<PlayfiversAgentConfig>;
  updateAgent(cfg: PlayfiversAgentConfig): Promise<{ status: boolean; msg?: string }>;
  listFreeBonus(): Promise<PlayfiversFreeBonus[]>;
  grantFreeBonus(p: { userCode: string; gameCode: string; rounds: number }): Promise<{ status: boolean; msg?: string }>;
  deleteFreeBonus(id: number): Promise<{ status: boolean; msg?: string }>;
  getBalances(): Promise<Record<string, number>>;
  listProviders(): Promise<{ id: number; name: string; walletName: string | null; imageUrl: string | null }[]>;
} = {
  key: "playfivers",
  name: "PlayFivers",
  configured: () => Boolean(TOKEN() && SECRET()),
  // Segredo do agente — usado para conferir os webhooks de entrada.
  secret: () => SECRET(),

  // Catálogo e provedores são públicos (não pedem credencial). Falha da API vira erro — nunca
  // "catálogo vazio", senão a sincronização desativaria todos os jogos.
  async listGames(): Promise<ExternalGame[]> {
    const [games, provs] = await Promise.all([pfJson("/api/v2/games"), pfJson("/api/v2/providers").catch(() => null)]);
    if (!games.ok || !Array.isArray(games.json?.data)) {
      throw pfError(games.status, games.json?.msg, "Falha ao ler o catálogo de jogos na PlayFivers.");
    }
    const logos = new Map<string, string | null>();
    const wallets = new Map<string, string | null>(); // provedor → carteira (o que o agente habilita é por carteira)
    const off = new Set<string>();
    for (const p of provs?.ok && Array.isArray(provs.json?.data) ? provs.json.data : []) {
      const slug = slugify(String(p?.name ?? ""));
      if (!slug) continue;
      logos.set(slug, p?.image_url ?? null);
      wallets.set(slug, p?.wallet?.name ? String(p.wallet.name).trim() : null);
      if (p?.status === false || p?.status === 0) off.add(slug); // provedor desligado na PlayFivers
    }
    return games.json.data
      .map((raw: unknown) => mapPlayfiversGame(raw, logos, wallets))
      .filter((g: ExternalGame) => g.externalId)
      .map((g: ExternalGame) => (off.has(g.providerSlug) ? { ...g, active: false } : g));
  },

  async launchUrl(opts: LaunchOptions): Promise<string> {
    if (opts.mode !== "real") throw new AppError("A PlayFivers abre só com conta (sem demo).", 400, "NO_DEMO");
    if (!opts.userCode) throw new AppError("Jogador obrigatório para abrir o jogo.", 400, "INVALID_SESSION");
    const { ok, json } = await pfJson("/api/v2/game_launch", {
      method: "POST",
      body: JSON.stringify({
        agentToken: TOKEN(),
        secretKey: SECRET(),
        user_code: opts.userCode,
        game_code: opts.externalId,
        provider: opts.providerName ?? "",
        game_original: opts.gameOriginal ?? false,
        user_balance: opts.userBalance ?? 0,
        lang: opts.lang ?? "pt",
      }),
    });
    if (!ok || !json?.launch_url) {
      throw new AppError(json?.msg || "Falha ao abrir o jogo na PlayFivers.", 502, "LAUNCH_FAILED");
    }
    return String(json.launch_url);
  },

  // A PlayFivers manda saldo, apostas e estornos para UMA "Callback URL" (separa pelo campo `type`).
  webhooks: (base) => [{ label: "Callback URL do agente (saldo, apostas e estornos)", url: `${base}/playfivers/callback` }],

  // ── Agente (RTP / limites / bônus) ──
  async getAgent(): Promise<PlayfiversAgentConfig> {
    const q = `agentToken=${encodeURIComponent(TOKEN())}&secretKey=${encodeURIComponent(SECRET())}`;
    const { ok, status, json } = await pfJson(`/api/v2/agent?${q}`);
    if (!ok || !json?.data) throw pfError(status, json?.msg, "Falha ao ler o agente na PlayFivers.");
    return json.data as PlayfiversAgentConfig;
  },
  async updateAgent(cfg): Promise<{ status: boolean; msg?: string }> {
    const { ok, status, json } = await pfJson("/api/v2/agent", {
      method: "PUT",
      body: JSON.stringify({
        agentToken: TOKEN(),
        secretKey: SECRET(),
        rtp: cfg.rtp,
        limit_enable: cfg.limit_enable,
        // a doc da PlayFivers grafa "limite_amount" (provável typo deles) — mandamos as duas chaves.
        limite_amount: cfg.limit_amount,
        limit_amount: cfg.limit_amount,
        limit_hours: cfg.limit_hours,
        bonus_enable: cfg.bonus_enable,
      }),
    });
    if (!ok || !json?.status) throw pfError(status, json?.msg, "Falha ao atualizar o agente na PlayFivers.");
    return json;
  },

  // ── Rodadas grátis ──
  async listFreeBonus(): Promise<PlayfiversFreeBonus[]> {
    // GET não carrega corpo; mandamos as credenciais por query (como os outros GET da PlayFivers).
    const q = `agent_token=${encodeURIComponent(TOKEN())}&secret_key=${encodeURIComponent(SECRET())}`;
    const { ok, status, json } = await pfJson(`/api/v2/free_bonus?${q}`);
    if (!ok) throw pfError(status, json?.msg, "Falha ao listar rodadas grátis na PlayFivers.");
    return Array.isArray(json?.data) ? (json.data as PlayfiversFreeBonus[]) : [];
  },
  async grantFreeBonus(p): Promise<{ status: boolean; msg?: string }> {
    const { ok, status, json } = await pfJson("/api/v2/free_bonus", {
      method: "POST",
      body: JSON.stringify({
        agent_token: TOKEN(),
        secret_key: SECRET(),
        user_code: p.userCode,
        game_code: p.gameCode,
        rounds: p.rounds,
      }),
    });
    if (!ok || !json?.status) throw pfError(status, json?.msg, "Falha ao conceder rodadas grátis na PlayFivers.");
    return json;
  },
  // ── Carteiras do agente (saldo pré-pago por grupo de provedor) ──
  async getBalances(): Promise<Record<string, number>> {
    const q = `agentToken=${encodeURIComponent(TOKEN())}&secretKey=${encodeURIComponent(SECRET())}`;
    const { ok, status, json } = await pfJson(`/api/v2/balances?${q}`);
    if (!ok || !json?.data || typeof json.data !== "object") throw pfError(status, json?.msg, "Falha ao ler as carteiras na PlayFivers.");
    const out: Record<string, number> = {};
    for (const [name, v] of Object.entries(json.data as Record<string, unknown>)) out[name] = Number(v) || 0;
    return out;
  },
  async listProviders() {
    const { ok, status, json } = await pfJson("/api/v2/providers");
    if (!ok) throw pfError(status, json?.msg, "Falha ao listar provedores na PlayFivers.");
    const data = Array.isArray(json?.data) ? json.data : [];
    return data.map((p: any) => ({
      id: Number(p?.id) || 0,
      name: String(p?.name ?? ""),
      walletName: p?.wallet?.name ? String(p.wallet.name) : null,
      imageUrl: p?.image_url ?? null,
    }));
  },

  async deleteFreeBonus(id): Promise<{ status: boolean; msg?: string }> {
    const { ok, status, json } = await pfJson("/api/v2/free_bonus", {
      method: "DELETE",
      body: JSON.stringify({ id, agent_token: TOKEN(), secret_key: SECRET() }),
    });
    if (!ok || !json?.status) throw pfError(status, json?.msg, "Falha ao remover a rodada grátis na PlayFivers.");
    return json;
  },
};
