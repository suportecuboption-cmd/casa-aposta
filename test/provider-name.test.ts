import { test } from "node:test";
import assert from "node:assert/strict";
import { providerDisplayName, providerDisplayNames } from "../src/lib/provider-name.js";

test("providerDisplayName: tira o OFICIAL e escreve a marca direito", () => {
  const cases: [string, string][] = [
    ["OFICIAL - PG SOFT", "PG Soft"], ["PGSOFT", "PG Soft"], ["OFICIAL - PRAGMATIC SLOTS", "Pragmatic Slots"],
    ["OFICIAL - RED TIGER", "Red Tiger"], ["OFICIAL - BIG TIME GAMING", "Big Time Gaming"], ["OFICIAL - NETENT", "NetEnt"],
    ["OFICIAL - BGAMING", "BGaming"], ["OFICIAL - 3OAKS", "3 Oaks"], ["OFICIAL - LIVE22", "Live22"], ["OFICIAL - JDB", "JDB"],
    ["OFICIAL - CG", "CG"], ["OFICIAL - GTF", "GTF"], ["OFICIAL - CP GAMES", "CP Games"], ["OFICIAL - FAT PANDA", "Fat Panda"],
    ["DIGITAIN OFICIAL", "Digitain"], ["OFICIAL - CQ9 Live", "CQ9 Live"], ["PLAYNGO", "Play'n GO"], ["CRASH GAMES", "Crash Games"],
    ["OFICIAL - EVOLUTION LIVE", "Evolution Live"], ["Minha Casa Games", "Minha Casa Games"], ["OFICIAL", "Oficial"],
  ];
  for (const [raw, want] of cases) assert.equal(providerDisplayName(raw), want, raw);
});

test("providerDisplayNames: a mesma marca em duas carteiras ganha (Oficial) no oficial", () => {
  const m = providerDisplayNames(["OFICIAL - EVOPLAY", "EVOPLAY", "OFICIAL - PG SOFT", "OFICIAL - PG SOFT"]);
  assert.equal(m.get("OFICIAL - EVOPLAY"), "Evoplay (Oficial)");
  assert.equal(m.get("EVOPLAY"), "Evoplay");
  assert.equal(m.get("OFICIAL - PG SOFT"), "PG Soft"); // repetido na lista não é colisão
  assert.equal(m.size, 3);
});
