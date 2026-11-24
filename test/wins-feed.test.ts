import { test } from "node:test";
import assert from "node:assert/strict";
import {
  maskPlayer,
  casinoCandidates,
  sportsCandidates,
  selectWins,
  multiplierOf,
  winsFeedConfigSchema,
  DEFAULT_WINS_FEED,
  type FeedTx,
} from "../src/services/wins-feed.js";

/* ── nome mascarado ── */

test("máscara: no máximo 3 caracteres e sempre esconde pelo menos 2", () => {
  assert.equal(maskPlayer("Lucas Lima", "x@y.com"), "Luc***");
  assert.equal(maskPlayer("lulu", "x@y.com"), "Lu***");
  assert.equal(maskPlayer("Ana", "x@y.com"), "A***");
  assert.equal(maskPlayer("Al", "x@y.com"), "A***");
  assert.equal(maskPlayer(null, "joao.silva@lab.local"), "Joa***"); // sem apelido: usa o e-mail, sem pontuação
  assert.equal(maskPlayer("   ", "érica@lab.local"), "Éri***");
  assert.equal(maskPlayer("p1795236187", "x@y.com"), "P17***");
  assert.equal(maskPlayer("***", "...@lab.local"), "Jog***");
});

/* ── cassino: uma vitória por rodada ── */

const at = (iso: string) => new Date(iso);
const tx = (o: Partial<FeedTx> & Pick<FeedTx, "id" | "type" | "amountC">): FeedTx =>
  ({ walletId: "w1", gameId: "g1", roundId: "r1", createdAt: at("2026-11-21T12:00:00Z"), reference: null, ...o });

test("cassino: prêmios da mesma rodada somam; aposta líquida desconta estorno", () => {
  const round = [
    tx({ id: "b1", type: "CASINO_BET", amountC: -1000 }),
    tx({ id: "b2", type: "CASINO_BET", amountC: -50 }),
    tx({ id: "rf", type: "CASINO_REFUND", amountC: 50 }),
    tx({ id: "w1", type: "CASINO_WIN", amountC: 33333, createdAt: at("2026-11-21T12:00:01Z") }),
    tx({ id: "w2", type: "CASINO_WIN", amountC: 22222, createdAt: at("2026-11-21T12:00:09Z") }),
  ];
  const wins = round.filter((t) => t.type === "CASINO_WIN");
  const [c, ...rest] = casinoCandidates(wins, round);
  assert.equal(rest.length, 0);
  assert.equal(c.amountC, 55555);
  assert.equal(c.stakeC, 1000);
  assert.equal(c.txId, "w2"); // último prêmio da rodada
  assert.equal(c.at.toISOString(), "2026-11-21T12:00:09.000Z");
  assert.equal(multiplierOf(c.amountC, c.stakeC), 55.56);
  // a chave não muda entre consultas (o site não "reanima" o mesmo card)
  assert.equal(casinoCandidates(wins.slice().reverse(), round)[0].key, c.key);
});

test("cassino: mesma rodada em jogos ou carteiras diferentes são vitórias separadas", () => {
  const all = [
    tx({ id: "a", type: "CASINO_WIN", amountC: 5000 }),
    tx({ id: "b", type: "CASINO_WIN", amountC: 6000, gameId: "g2" }),
    tx({ id: "c", type: "CASINO_WIN", amountC: 7000, walletId: "w2" }),
  ];
  assert.equal(casinoCandidates(all, all).length, 3);
});

test("cassino: prêmio sem rodada vale sozinho e o multiplicador fica desconhecido", () => {
  const w = tx({ id: "solo", type: "CASINO_WIN", amountC: 9000, roundId: null });
  const [c] = casinoCandidates([w], []);
  assert.deepEqual([c.amountC, c.stakeC, multiplierOf(c.amountC, c.stakeC)], [9000, null, null]);
});

/* ── esportes ── */

test("esportes: aposta vem do bilhete; bilhete desconhecido fica sem multiplicador", () => {
  const ws = [
    tx({ id: "s1", type: "BET_WIN", amountC: 39900, reference: "betslip:abc", roundId: null, gameId: null }),
    tx({ id: "s2", type: "BET_WIN", amountC: 12000, reference: "betslip:zzz", roundId: null, gameId: null }),
  ];
  const [a, b] = sportsCandidates(ws, new Map([["abc", 10000]]));
  assert.deepEqual([a.product, a.stakeC, multiplierOf(a.amountC, a.stakeC)], ["sports", 10000, 3.99]);
  assert.equal(b.stakeC, null);
});

/* ── seleção final ── */

test("seleção: mínimo em centavos, só lucro de verdade, mais recentes primeiro e limite", () => {
  const c = (key: string, amountC: number, stakeC: number | null, iso: string) =>
    ({ key, txId: key, walletId: "w", product: "casino" as const, amountC, stakeC, at: at(iso), gameId: null, reference: null });
  const picked = selectWins(
    [
      c("antiga", 8000, 1000, "2026-11-20T10:00:00Z"),
      c("no-limite", 5000, 1000, "2026-11-21T10:00:00Z"),       // exatamente o mínimo: entra
      c("abaixo", 4999, 100, "2026-11-21T11:00:00Z"),           // R$ 49,99: fora
      c("empate", 7777, 7777, "2026-11-21T12:00:00Z"),          // só devolveu a aposta: fora
      c("perdeu-no-total", 6000, 9000, "2026-11-21T12:30:00Z"), // prêmio menor que a aposta: fora
      c("sem-aposta", 6000, null, "2026-11-21T13:00:00Z"),      // aposta desconhecida: entra
      c("nova", 20000, 1000, "2026-11-21T14:00:00Z"),
    ],
    { minAmount: 50, limit: 3 },
  );
  assert.deepEqual(picked.map((x) => x.key), ["nova", "sem-aposta", "no-limite"]);
});

/* ── ajustes ── */

test("ajustes: padrão válido; recusa nada selecionado, centavo quebrado e limites", () => {
  assert.equal(winsFeedConfigSchema.safeParse(DEFAULT_WINS_FEED).success, true);
  assert.equal(winsFeedConfigSchema.safeParse({ ...DEFAULT_WINS_FEED, minAmount: 50.3 }).success, true);
  assert.equal(winsFeedConfigSchema.safeParse({ ...DEFAULT_WINS_FEED, casino: false, sports: false }).success, false);
  assert.equal(winsFeedConfigSchema.safeParse({ ...DEFAULT_WINS_FEED, minAmount: 10.123 }).success, false);
  assert.equal(winsFeedConfigSchema.safeParse({ ...DEFAULT_WINS_FEED, minAmount: -1 }).success, false);
  assert.equal(winsFeedConfigSchema.safeParse({ ...DEFAULT_WINS_FEED, limit: 31 }).success, false);
  assert.equal(winsFeedConfigSchema.safeParse({ ...DEFAULT_WINS_FEED, maxAgeDays: 0 }).success, false);
});
