import { prisma } from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";
import { playfiversAdapter } from "../casino/adapters/playfivers.js";
import { invalidateCatalog } from "./catalog-cache.js";

/**
 * Carteiras habilitadas (PlayFivers). Lá cada provedor pertence a uma carteira e o agente só joga
 * o que as carteiras dele cobrem — então o site mostra apenas jogos de provedores dessas carteiras.
 * Fonte: GET /api/v2/balances (as carteiras do agente; exige token/segredo da Instalação) ou a escolha
 * manual no admin enquanto o token não foi configurado. Sem nada definido o cassino fica vazio: melhor que
 * mostrar jogo que a conta não cobre.
 */

const KEY = "casinoWallets";

export interface WalletSettings {
  enabled: string[];
  source: "playfivers" | "manual" | null;
  balances: Record<string, number> | null; // última leitura do /balances
  checkedAt: string | null;
  unmatched: string[]; // carteiras do agente sem provedor conhecido no catálogo
}
const EMPTY: WalletSettings = { enabled: [], source: null, balances: null, checkedAt: null, unmatched: [] };

export const normWallet = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

/** Pura: casa as carteiras devolvidas pela PlayFivers com as carteiras dos provedores do catálogo. */
export function matchWallets(balanceKeys: string[], known: string[]) {
  const byNorm = new Map(known.map((k) => [normWallet(k), k]));
  const matched = new Set<string>();
  const unmatched: string[] = [];
  for (const key of balanceKeys) {
    const hit = byNorm.get(normWallet(key));
    if (hit) matched.add(hit);
    else unmatched.push(key);
  }
  return { matched: [...matched].sort((a, b) => a.localeCompare(b, "pt-BR")), unmatched };
}

export async function getWalletSettings(): Promise<WalletSettings> {
  const row = await prisma.siteSetting.findUnique({ where: { key: KEY } });
  if (!row) return { ...EMPTY };
  try {
    return { ...EMPTY, ...JSON.parse(row.value) };
  } catch {
    return { ...EMPTY };
  }
}

async function save(s: WalletSettings, adminId: string | null, action: string) {
  const value = JSON.stringify(s);
  await prisma.siteSetting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } });
  if (adminId) {
    await prisma.adminAuditLog.create({
      data: { adminId, action, target: KEY, payload: JSON.stringify({ enabled: s.enabled, source: s.source, unmatched: s.unmatched }) },
    });
  }
  invalidateCatalog();
  return s;
}

/** Carteiras conhecidas (vêm dos provedores sincronizados da PlayFivers). */
export async function knownWallets(): Promise<string[]> {
  const rows = await prisma.gameProvider.findMany({ where: { wallet: { not: null } }, select: { wallet: true }, distinct: ["wallet"] });
  return rows.map((r) => r.wallet!).sort((a, b) => a.localeCompare(b, "pt-BR"));
}

/** Escolha manual no admin (enquanto o token da PlayFivers não está configurado). */
export async function saveManualWallets(enabled: string[], adminId: string) {
  const known = new Set(await knownWallets());
  const unknown = enabled.filter((w) => !known.has(w));
  if (unknown.length) throw new AppError(`Carteira desconhecida: ${unknown.join(", ")}`, 400, "UNKNOWN_WALLET");
  const cur = await getWalletSettings();
  return save({ ...cur, enabled: [...new Set(enabled)], source: "manual", unmatched: [] }, adminId, "CASINO_WALLETS_SET");
}

/** Lê as carteiras do agente na PlayFivers e habilita exatamente elas. */
export async function detectWallets(adminId: string | null) {
  if (!playfiversAdapter.configured()) {
    throw new AppError("Configure o token e o segredo da PlayFivers em Ajustes → Instalação para detectar as carteiras.", 409, "NOT_CONFIGURED");
  }
  const balances = await playfiversAdapter.getBalances();
  const { matched, unmatched } = matchWallets(Object.keys(balances), await knownWallets());
  return save(
    { enabled: matched, source: "playfivers", balances, checkedAt: new Date().toISOString(), unmatched },
    adminId,
    "CASINO_WALLETS_DETECT",
  );
}

/** Resumo por carteira para o admin: provedores, jogos, saldo lido e se está habilitada. */
export async function walletsOverview() {
  const [settings, providers, active] = await Promise.all([
    getWalletSettings(),
    prisma.gameProvider.findMany({
      select: { id: true, slug: true, name: true, wallet: true, _count: { select: { games: true } } },
      orderBy: { name: "asc" },
    }),
    prisma.game.groupBy({ by: ["providerId"], where: { isActive: true }, _count: { _all: true } }),
  ]);
  const activeBy = new Map(active.map((a) => [a.providerId, a._count._all]));
  const enabled = new Set(settings.enabled);
  const balanceOf = (name: string) => {
    if (!settings.balances) return null;
    const k = Object.keys(settings.balances).find((x) => normWallet(x) === normWallet(name));
    return k === undefined ? null : settings.balances[k];
  };
  type Row = { name: string; enabled: boolean; balance: number | null; games: number; activeGames: number; providers: { slug: string; name: string; games: number; activeGames: number }[] };
  const byWallet = new Map<string, Row>();
  for (const p of providers) {
    if (!p.wallet) continue;
    const w = byWallet.get(p.wallet) ?? byWallet.set(p.wallet, { name: p.wallet, enabled: enabled.has(p.wallet), balance: balanceOf(p.wallet), games: 0, activeGames: 0, providers: [] }).get(p.wallet)!;
    const act = activeBy.get(p.id) ?? 0;
    w.providers.push({ slug: p.slug, name: p.name, games: p._count.games, activeGames: act });
    w.games += p._count.games;
    w.activeGames += act;
  }
  return {
    configured: playfiversAdapter.configured(),
    settings,
    wallets: [...byWallet.values()].sort((a, b) => b.games - a.games),
  };
}
