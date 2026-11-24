/** Jogo como vem do catálogo do agregador (API). */
export interface ExternalGame {
  externalId: string; // chave única no agregador (na PlayFivers: "<provedor>:<game_code>")
  code?: string; // código cru do jogo, como o agregador espera no launch
  name: string;
  providerSlug: string;
  providerName: string;
  providerRaw?: string; // nome do provedor exatamente como o agregador espera no launch
  providerLogo?: string | null;
  providerWallet?: string | null; // carteira do agregador a que o provedor pertence (PlayFivers)
  category: string; // slots | live | mesa | crash | ...
  imageUrl?: string | null;
  hasDemo?: boolean;
  isLive?: boolean;
  original?: boolean; // alguns agregadores (PlayFivers) exigem esse flag no launch
  active?: boolean; // disponível no agregador (status); false = entra/fica inativo
}

export interface LaunchOptions {
  externalId: string;
  mode: "real" | "demo";
  token?: string; // sessão do jogador (só no modo real)
  lang?: string;
  // Dados do jogador exigidos por agregadores seamless que lançam o jogo via API (PlayFivers):
  userCode?: string;      // id do jogador no nosso sistema
  userBalance?: number;   // saldo atual do jogador
  providerName?: string;  // nome do provedor no agregador
  gameOriginal?: boolean; // se o jogo é "original"
}

/**
 * Contrato de cada integração de cassino (agregador). Para plugar um agregador real,
 * implemente este contrato com a API dele e registre em casino/registry.ts.
 */
export interface CasinoAdapter {
  key: string; // aparece na URL de callback: /casino/callback/<key>
  name: string;
  configured(): boolean;
  /** Segredo compartilhado com o agregador para assinar os callbacks. */
  secret(): string;
  /** Catálogo de jogos via API do agregador. */
  listGames(): Promise<ExternalGame[]>;
  /** URL que vai no iframe do jogo. */
  launchUrl(opts: LaunchOptions): Promise<string>;
  /** Agregadores com webhooks próprios (ex.: PlayFivers) expõem as URLs a cadastrar no painel deles. */
  webhooks?(base: string): { label: string; url: string }[];
}
