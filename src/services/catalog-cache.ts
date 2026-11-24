import zlib from "node:zlib";

/**
 * Cache do catálogo público (/games). Com os milhares de jogos da PlayFivers a resposta passa de
 * 3 MB: montamos uma vez, guardamos já comprimida (gzip) e invalidamos quando a sincronização ou o
 * admin mudam jogos/provedores. O TTL cobre qualquer escrita que não passe por aqui.
 */
const TTL_MS = 60_000;
let cache: { at: number; json: string; gz: Buffer } | null = null;

export function invalidateCatalog() {
  cache = null;
}

export async function catalogPayload(build: () => Promise<unknown>) {
  if (cache && Date.now() - cache.at < TTL_MS) return cache;
  const json = JSON.stringify(await build());
  cache = { at: Date.now(), json, gz: zlib.gzipSync(json) };
  return cache;
}
