import type { CasinoAdapter } from "./types.js";
import { playfiversAdapter } from "./adapters/playfivers.js";

/** Integrações de cassino. Todo o catálogo e a abertura dos jogos vêm da PlayFivers. */
const adapters: CasinoAdapter[] = [playfiversAdapter];

export const listAdapters = () => adapters;
export const getAdapter = (key: string | null | undefined) => adapters.find((a) => a.key === key) ?? null;
