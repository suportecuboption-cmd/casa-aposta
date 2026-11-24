# casa-aposta (lab)

Backend greenfield inspirado em catálogo público de iGaming (cassino + sportsbook + PIX). **Código original** — não replica embaloubet.io.

## Stack

Node 20 · TypeScript · Fastify · Prisma · SQLite

## Subir

```powershell
cd C:\Users\USER\Desktop\.cursor\casa-aposta
copy .env.example .env
npm install
npm run db:push
npm run db:seed
npm run dev
```

- API: `http://127.0.0.1:3090/health`
- OpenAPI JSON: `http://127.0.0.1:3090/openapi.json`
- Admin UI: `http://127.0.0.1:3090/admin/`
- Player UI: `http://127.0.0.1:3090/app/` — interface completa estilo sportsbook
  (tema escuro, sidebar de esportes, cards de eventos com odds 1X2, **bilhete**
  lateral fixo / bottom-sheet no mobile, cassino, carteira e depósito PIX mock).
  Marca própria `casa-aposta` — layout original, não replica nenhuma marca real.
- Admin default: `admin@lab.local` / `Admin123!`
- Cassino: os jogos vêm todos da **PlayFivers**. As credenciais do agente ficam no banco (não no
  `.env`): no admin, abra **Ajustes → Instalação**, preencha token, segredo, código do agente e os
  IPs dos webhooks e clique em **Salvar e testar conexão**. Depois sincronize em Cassino →
  Integrações → **Sincronizar jogos** (o catálogo é público; os jogos só abrem valendo com as
  credenciais salvas). No agente da PlayFivers, o campo **Callback URL** aponta para
  `<seu domínio>/playfivers/callback` — saldo, apostas e estornos chegam todos nela (a URL aparece em
  Instalação e Integrações).
- Capas dos jogos: baixadas da CDN da PlayFivers, reduzidas para miniatura (WEBP 360 px, ~18 KB) e
  servidas de `/uploads/games/` com cache de 1 ano (admin → Integrações → Capas dos jogos; roda sozinho
  depois de "Sincronizar jogos"). Capa que não existe na CDN deles fica sem imagem (o card mostra o nome).
  A vitrine mostra primeiro os jogos com capa (o "Em alta" e a ordem manual do admin continuam mandando)
  e as fileiras dos provedores com mais jogos com capa; o menu de provedores segue pelo número de jogos.
- Marca: admin → **Ajustes → Marca** define o nome do site, a logo (texto em duas cores ou imagem, com
  versão opcional para o tema escuro), o ícone (favicon) e o link do botão Suporte. Fica no banco
  (SiteSetting `brand`); o servidor escreve título, favicon e logo direto no HTML de `/app/`
  (`src/routes/site.ts`), então a marca padrão não "pisca" e a prévia de link já sai com o nome certo.
  Imagens enviadas viram PNG no servidor (SVG incluso — o arquivo servido nunca carrega script).
- Celular (até 760 px): busca e atalhos (Início + categorias) no topo, banner compacto, fileiras com
  "Ver todos" e cards quadrados só com a capa, barra de abas fixa (Início, Ao vivo, Apostas, Cassino,
  Conta) e menu do hambúrguer em tela cheia. No computador o layout não mudou.
- Provedores aparecem com nome limpo para o jogador ("OFICIAL - PG SOFT" → "PG Soft",
  `src/lib/provider-name.ts`); o admin continua vendo o nome cru (ele diz de qual carteira vem).
- Fidelidade (admin → **Fidelidade**), com o crédito dos prêmios como lançamento `BONUS` na carteira
  (conta bloqueada ou em autoexclusão não recebe):
  - **Nível VIP**: o jogador sobe de nível pelo total apostado (cassino + esportes, menos estornos) e
    resgata uma vez o bônus de cada nível. Níveis, valores e cores editáveis (padrão: Bronze → Diamante).
  - **Coleções**: álbuns de cartas em que cada carta é um jogo. A cada R$ X apostados o jogador ganha um
    pacote (padrão R$ 100, 3 cartas); completou o álbum, resgata o prêmio uma vez. O admin monta o álbum
    com os jogos de um provedor ou buscando pelo nome.
- **Instale o app**: o site é instalável (manifest + ícones gerados da Marca + service worker que só guarda
  a página). No Android/Chrome abre o convite de instalação; no iPhone, o passo a passo do Safari. Precisa
  de https (o túnel serve).
- **Incentivos** (admin → **Incentivos** → Campanhas / Jogadores): campanhas de bônus com **rollover** que valem só
  nos jogos escolhidos (busca por nome ou "todos os jogos de um provedor").
  - Como o jogador recebe: **no depósito** (escolhe o bônus ao gerar o PIX; % do depósito com teto, depósito
    mínimo, opção "só no 1º depósito"; o bônus entra quando o PIX cai), **resgate pelo jogador** (valor fixo,
    opção "só para quem já depositou") ou **só a equipe concede** (pela campanha ou pela ficha → aba Bônus).
  - Rollover: N × o bônus (ou × depósito + bônus), prazo em dias, aposta máxima que conta, teto de conversão,
    vezes por jogador, período e ordem no site. Valor, rollover, aposta máxima, teto e prazo ficam gravados no
    incentivo de quem já recebeu (editar a campanha não muda o combinado; os jogos valem na hora).
  - Dinheiro: o bônus fica em `Wallet.bonus` (um incentivo ativo por jogador). Dinheiro real é usado primeiro; o
    bônus só paga aposta nos jogos da campanha e o prêmio volta na proporção da aposta. Toda aposta nesses jogos
    soma ao rollover. Saque travado até cumprir (o jogador pode cancelar e perde o bônus). Cumpriu → o bônus vira
    saldo real com lançamento `BONUS`; venceu o prazo ou zerou → retirado (varredura a cada minuto).
  - Extrato do bônus em `BonusTransaction`; o `WalletTransaction` continua só com dinheiro real (GGR e relatórios
    iguais). A fatura do agregador soma as rodadas pagas com bônus (ele cobra sobre a aposta inteira). O saldo de
    bônus aparece em **Bloqueado** no dashboard. Regras puras em `src/services/incentive-rules.ts`.
- Pagamentos: admin → **Pagamentos → Gateways** escolhe com um clique o gateway de PIX (SwytchPay ou
  BSPay; sem nenhum ativo = modo manual, a equipe aprova). Cada gateway tem tela de configuração
  (credenciais no banco, segredos nunca voltam para a tela) e aviso em `/payments/webhook/<gateway>`.
  Defina a **URL pública** (https, ex.: o túnel) para os avisos chegarem.

## Testes

```powershell
npm test   # node:test — limites de depósito/saque da carteira
```

## Bilhete de aposta (sportsbook)

Bilhete = 1+ seleções. `type` é derivado: `SINGLE` (1 seleção) ou `MULTIPLE`
(acumulada). A odd de cada seleção é **fotografada** no momento da aposta
(`oddsAtPlacement`), a `combinedOdds` é o produto das odds e o `potentialReturn`
= `stake × combinedOdds`.

Fluxo:

1. `POST /betslips` — valida, confere saldo, debita a carteira (`BET_STAKE`) e
   cria o bilhete + seleções numa transação. `clientRef` opcional dá
   idempotência (retry seguro para uma API cliente).
2. `POST /api/admin/events/:id/settle { outcome }` — define o resultado do
   evento, marca cada seleção `WON`/`LOST` e liquida os bilhetes: perdeu uma
   perna → `LOST`; todas ganharam → `WON` + crédito `BET_WIN` na carteira; ainda
   há perna em aberto → permanece `OPEN`.

### Arquitetura & futura API de odds

A lógica de negócio vive em `src/services/betslip.ts` (montagem + liquidação),
separada das rotas. As odds/eventos são lidas de `SportEvent` — este é o **ponto
de integração**: para plugar uma API externa de iGaming no futuro, basta um job
que faça *upsert* de `SportEvent` (odds/resultados) e, opcionalmente, chame
`settleEvent()` ao receber o resultado. Nada mais no código precisa mudar.

## Validação & schemas

Todas as rotas validam entrada com Zod. Schemas compartilhados em `src/schemas/`
(fonte única de verdade, reusada pelo `GET /openapi.json` e pelos testes).
Erros de validação retornam `400 { error: "VALIDATION", issues: [...] }`.

## Rotas principais

| Área | Endpoints |
|------|-----------|
| Auth | `POST /auth/register`, `POST /auth/login`, `GET /auth/me` |
| Carteira | `GET /wallet`, `POST /wallet/deposit/pix`, `POST /wallet/withdraw/pix` |
| Catálogo | `GET /games`, `GET /sports` |
| Bilhete | `POST /betslips`, `GET /betslips/mine`, `GET /betslips/:id` |
| Admin | `/api/admin/*` (JWT role ADMIN/FINANCE/SUPPORT) incl. `POST /api/admin/events/:id/settle` |

## Claude Code e safeguard `[cyber]`

O Opus 5.5 bloqueia **no servidor** (não contorna com CLAUDE.md). Gatilhos comuns:

- URL de site de apostas real + catálogo/cassino
- `obediencia` / jailbreak na mesma mensagem
- Sessão que já foi flagged (reabrir **sessão nova**)

Prompts: `CLAUDE-PROMPT-SEGURO.txt` (v2) ou `CLAUDE-PROMPT-1-LINHA.txt` · ou **Opus 4.8** no diálogo.

Backend já corre aqui no Cursor; Claude Code só para iteração extra.