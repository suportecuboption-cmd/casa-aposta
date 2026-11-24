import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { pfBalanceWebhookSchema, pfTxnTopSchema, pfSlotSchema } from "../schemas/index.js";
import {
  pfBalance,
  pfWinBet,
  pfRefund,
  ipAllowed,
  agentCheck,
  callbackKind,
  pfErrorBody,
  type PfCallbackKind,
} from "../services/playfivers.js";
import { pfInstall } from "../services/install-config.js";

/**
 * Callbacks que a PlayFivers chama no NOSSO servidor (carteira seamless).
 *
 * Na prática a PlayFivers manda TODOS os eventos — saldo (BALANCE) e transações (WinBet/Refund) — para a
 * "Callback URL" cadastrada no agente, sem acrescentar caminho; o que separa um do outro é o campo `type`.
 * Por isso um único despachante atende em várias rotas:
 *   - /playfivers/callback      → a recomendada para colar no agente
 *   - /                         → caso o Callback URL tenha sido cadastrado como a raiz do domínio
 *   - /webhook e /api/webhook   → caminhos da doc (saldo e transação), mantidos por compatibilidade
 *
 * Autenticação: IP allowlist (Ajustes → Instalação) + agent_secret/agent_code no corpo das transações
 * (o callback de saldo não manda segredo). Respostas no formato da doc: { msg, balance }, com
 * INVALID_USER / INSUFFICIENT_USER_FUNDS / ERROR_INTERNAL nos erros.
 */

const guardIp = (req: FastifyRequest) => ipAllowed(req.ip, pfInstall().ipAllowlist);

async function sendPfError(req: FastifyRequest, reply: FastifyReply, e: unknown, userCode: string) {
  const { status, msg } = pfErrorBody(e);
  if (status >= 500) req.log.error({ err: e }, "callback PlayFivers: erro interno");
  // Com saldo insuficiente, devolve o saldo real para o jogo mostrar o valor certo.
  const balance = msg === "INSUFFICIENT_USER_FUNDS" ? await pfBalance(userCode).catch(() => 0) : 0;
  return reply.status(status).send({ msg, balance });
}

async function handleBalance(req: FastifyRequest, reply: FastifyReply) {
  const parsed = pfBalanceWebhookSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ msg: "INVALID_REQUEST", balance: 0 });
  try {
    return { msg: "", balance: await pfBalance(parsed.data.user_code) };
  } catch (e) {
    return sendPfError(req, reply, e, parsed.data.user_code);
  }
}

async function handleTxn(req: FastifyRequest, reply: FastifyReply) {
  const body = (req.body ?? {}) as Record<string, any>;
  const auth = agentCheck(body, pfInstall().agentCode, pfInstall().secretKey);
  if (!auth.ok) {
    // Nunca loga o segredo — só qual conferência falhou e o agent_code recebido (que não é segredo).
    req.log.warn(
      {
        reason: auth.reason,
        receivedAgentCode: typeof body.agent_code === "string" ? body.agent_code : undefined,
        secretPresent: typeof body.agent_secret === "string" && body.agent_secret.length > 0,
      },
      "callback PlayFivers recusado (credenciais do agente)",
    );
    return reply.status(401).send({ msg: "INVALID_AGENT", balance: 0 });
  }
  // tolera "winbet"/"refund" em minúsculas
  const t0 = typeof body.type === "string" ? body.type.trim().toLowerCase() : "";
  const type = t0 === "refund" ? "Refund" : t0 === "winbet" ? "WinBet" : body.type;
  const top = pfTxnTopSchema.safeParse({ ...body, type });
  // o objeto da transação normalmente vem em `slot`, mas pode variar pelo game_type
  const rawTx = body.slot ?? (typeof body.game_type === "string" ? body[body.game_type] : undefined);
  const slot = pfSlotSchema.safeParse(rawTx);
  if (!top.success || !slot.success) {
    req.log.warn({ type: body.type, gameType: body.game_type }, "callback PlayFivers de transação com corpo inválido");
    return reply.status(400).send({ msg: "INVALID_REQUEST", balance: 0 });
  }
  const t = top.data;
  const s = slot.data;
  try {
    const r =
      t.type === "Refund"
        ? await pfRefund({ userCode: t.user_code, txnId: s.txn_id })
        : await pfWinBet({
            userCode: t.user_code,
            txnId: s.txn_id,
            roundId: s.round_id,
            bet: s.bet ?? 0,
            win: s.win ?? 0,
            gameCode: s.game_code,
            providerCode: s.provider_code,
          });
    return { msg: "", balance: r.balance };
  } catch (e) {
    return sendPfError(req, reply, e, t.user_code);
  }
}

export async function playfiversWebhookRoutes(app: FastifyInstance) {
  // `fallback` = o que a rota antiga atendia quando o corpo não traz `type`.
  const callback = (fallback: PfCallbackKind | null) => async (req: FastifyRequest, reply: FastifyReply) => {
    if (!guardIp(req)) return reply.status(403).send({ msg: "IP não autorizado", balance: 0 });
    const kind = callbackKind(req.body) ?? fallback;
    if (kind === "balance") return handleBalance(req, reply);
    if (kind === "txn") return handleTxn(req, reply);
    req.log.warn(
      { type: (req.body as { type?: unknown } | undefined)?.type, contentType: req.headers["content-type"] },
      "callback PlayFivers com tipo desconhecido",
    );
    return reply.status(400).send({ msg: "INVALID_REQUEST", balance: 0 });
  };

  app.post("/playfivers/callback", callback(null));
  app.post("/", callback(null));
  app.post("/webhook", callback("balance"));
  app.post("/api/webhook", callback("txn"));
}
