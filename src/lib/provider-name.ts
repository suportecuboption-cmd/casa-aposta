/**
 * Nome do provedor para o JOGADOR. A PlayFivers manda "OFICIAL - PG SOFT", "PGSOFT", "DIGITAIN OFICIAL"…
 * O site mostra "PG Soft"; o admin continua vendo o nome cru (ele diz de qual carteira o provedor vem).
 * Nome que o admin já escreveu com minúsculas fica como está (só sai o prefixo "OFICIAL - ").
 */

// Grafia oficial das marcas (chave: só letras e números, em maiúsculas).
const KNOWN: Record<string, string> = {
  "3OAKS": "3 Oaks", ADVANTPLAY: "AdvantPlay", ASKMESLOT: "AskMeSlot", BGAMING: "BGaming", BIGTIMEGAMING: "Big Time Gaming",
  BTG: "Big Time Gaming", EPICWIN: "EpicWin", FACHAI: "Fa Chai", FATPANDA: "Fat Panda", MICROGAMING: "Microgaming",
  NETENT: "NetEnt", PGSOFT: "PG Soft", TADA: "TaDa", SPADEGAMING: "Spadegaming", YELLOWBAT: "Yellow Bat",
  DREAMGAMINGLIVE: "Dream Gaming Live", DREAMGAMING: "Dream Gaming", QUEENMAKER: "Queenmaker", EGT: "EGT",
  JILI: "JILI", DUSLOT: "DuSlot", FASTSPIN: "FastSpin", PLAYNGO: "Play'n GO", POPOK: "PopOK", REELKINGDOM: "Reel Kingdom",
  RUBYPLAY: "Ruby Play", TOPTREND: "TopTrend Gaming", BOOONGO: "Booongo", DREAMTECH: "Dreamtech", CQ9: "CQ9",
};

const squash = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
const OFICIAL = /^(OFICIAL|OFFICIAL|ORIGINAL)\s*[-–—:|]\s*|\s+(OFICIAL|OFFICIAL)$/gi;
// Sigla fica em maiúsculas (PG, CG, JDB, GTF); palavra normal vira "Palavra".
const titleWord = (w: string) => (w.length <= 2 || !/[AEIOU]/.test(w) ? w : w.charAt(0) + w.slice(1).toLowerCase());

/** Pura: "OFICIAL - PG SOFT" → "PG Soft"; "DIGITAIN OFICIAL" → "Digitain"; "LIVE22" → "Live22". */
export function providerDisplayName(raw: string): string {
  const trimmed = (raw ?? "").trim();
  const base = trimmed.replace(OFICIAL, "").trim() || trimmed;
  const known = KNOWN[squash(base)];
  if (known) return known;
  if (/[a-z]/.test(base)) return base; // o admin já escreveu do jeito dele
  return base.split(/\s+/).map(titleWord).join(" ");
}

/**
 * Pura: nomes de exibição de vários provedores de uma vez. Se dois ficarem iguais (a mesma marca em duas
 * carteiras, ex.: "OFICIAL - EVOPLAY" e "EVOPLAY"), o oficial ganha "(Oficial)" para o jogador distinguir.
 */
export function providerDisplayNames(rawNames: Iterable<string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of rawNames) if (!out.has(raw)) out.set(raw, providerDisplayName(raw));
  const seen = new Map<string, number>();
  for (const d of out.values()) seen.set(d, (seen.get(d) ?? 0) + 1);
  for (const [raw, d] of out) if ((seen.get(d) ?? 0) > 1 && /^(OFICIAL|OFFICIAL)\b/i.test(raw.trim())) out.set(raw, `${d} (Oficial)`);
  return out;
}
