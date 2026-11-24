import { prisma } from "../lib/prisma.js";

/**
 * Score de risco do jogador (0–100), por componentes como no Axio: Pagamentos, Falhas de
 * Pagamento, Compliance, Sessões, Produto, Cashback e Multi-Conta. Cada componente vale de 0 a
 * 100; o score é a média ponderada. Pesos escolhidos para reproduzir o exemplo do Axio
 * (só Compliance = 66,67 → score 10).
 */

export interface RiskSignals {
  deposits30: number;        // depósitos pagos em 30 dias
  depositAmount30: number;   // valor depositado em 30 dias (R$)
  failedPix30: number;       // PIX recusados/expirados em 30 dias
  kycVerified: boolean;
  accountAgeDays: number;
  hasCpf: boolean;
  distinctIps30: number;     // IPs diferentes nos acessos de 30 dias
  sessions30: number;        // acessos registrados em 30 dias
  turnover30: number;        // apostado em 30 dias (R$)
  payout30: number;          // devolvido ao jogador em 30 dias (R$)
  sharedPhoneUsers: number;  // outras contas com o mesmo celular
  sharedIpUsers: number;     // outras contas que acessaram do mesmo IP (30 dias)
}

export const RISK_WEIGHTS = {
  payments: 0.2,
  paymentFailures: 0.15,
  compliance: 0.15,
  sessions: 0.1,
  product: 0.2,
  cashback: 0.05,
  multiAccount: 0.15,
} as const;

export const RISK_LABELS: Record<keyof typeof RISK_WEIGHTS, string> = {
  payments: "Pagamentos",
  paymentFailures: "Falhas de Pagamento",
  compliance: "Compliance",
  sessions: "Sessões",
  product: "Produto",
  cashback: "Cashback",
  multiAccount: "Multi-Conta",
};

export type RiskLevel = "Baixo" | "Médio" | "Alto";
const cap = (v: number) => Math.min(100, Math.round(v * 100) / 100);

/** Pura: calcula componentes, score e nível a partir dos sinais. */
export function riskScore(s: RiskSignals) {
  const parts: Record<keyof typeof RISK_WEIGHTS, { value: number; notes: string[] }> = {
    payments: { value: 0, notes: [] },
    paymentFailures: { value: 0, notes: [] },
    compliance: { value: 0, notes: [] },
    sessions: { value: 0, notes: [] },
    product: { value: 0, notes: [] },
    cashback: { value: 0, notes: [] },
    multiAccount: { value: 0, notes: [] },
  };
  const add = (k: keyof typeof parts, v: number, note: string) => { parts[k].value += v; parts[k].notes.push(note); };

  if (s.deposits30 >= 15) add("payments", 50, `${s.deposits30} depósitos em 30 dias.`);
  if (s.depositAmount30 >= 20000) add("payments", 50, "Volume de depósito alto em 30 dias.");
  if (s.failedPix30 > 0) add("paymentFailures", s.failedPix30 * 25, `${s.failedPix30} PIX recusado(s) ou expirado(s) em 30 dias.`);
  if (!s.kycVerified) add("compliance", 100 / 3, "Nível de compliance baixo (KYC não verificado).");
  if (s.accountAgeDays < 7) add("compliance", 100 / 3, "Conta muito nova.");
  if (!s.hasCpf) add("compliance", 100 / 3, "Sem CPF no cadastro.");
  if (s.distinctIps30 >= 5) add("sessions", 60, `Acessos de ${s.distinctIps30} IPs diferentes em 30 dias.`);
  if (s.sessions30 >= 300) add("sessions", 40, "Volume de sessões muito alto.");
  if (s.turnover30 >= 500 && s.payout30 / s.turnover30 >= 1.2) add("product", 60, "RTP do jogador acima de 120% com volume relevante.");
  if (s.payout30 - s.turnover30 >= 5000) add("product", 40, "Lucro alto contra a casa em 30 dias.");
  if (s.sharedPhoneUsers > 0) add("multiAccount", 50, `Celular usado por ${s.sharedPhoneUsers} outra(s) conta(s).`);
  if (s.sharedIpUsers > 0) add("multiAccount", 50, `Mesmo IP de ${s.sharedIpUsers} outra(s) conta(s).`);

  const components = (Object.keys(parts) as (keyof typeof parts)[]).map((k) => ({
    key: k,
    label: RISK_LABELS[k],
    value: cap(parts[k].value),
    notes: parts[k].notes,
  }));
  const score = Math.round(components.reduce((acc, c) => acc + c.value * RISK_WEIGHTS[c.key], 0));
  const level: RiskLevel = score >= 60 ? "Alto" : score >= 30 ? "Médio" : "Baixo";
  return { score, level, components };
}

/** Junta os sinais de um jogador no banco (janela de 30 dias). */
export async function loadRiskSignals(userId: string, now = new Date()): Promise<RiskSignals> {
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { createdAt: true, cpf: true, phone: true, kyc: { select: { verified: true } }, wallet: { select: { id: true } } },
  });
  if (!user) throw new Error("Usuário não encontrado");
  const [deps, failed, acts, play] = await Promise.all([
    prisma.pixOrder.aggregate({ where: { userId, kind: "DEPOSIT", status: "PAID", paidAt: { gte: since } }, _sum: { amount: true }, _count: { _all: true } }),
    prisma.pixOrder.count({ where: { userId, status: { in: ["FAILED", "EXPIRED"] }, createdAt: { gte: since } } }),
    prisma.userActivity.findMany({ where: { userId, at: { gte: since } }, select: { ip: true } }),
    user.wallet
      ? prisma.walletTransaction.groupBy({
          by: ["type"],
          where: { walletId: user.wallet.id, createdAt: { gte: since }, type: { in: ["BET_STAKE", "CASINO_BET", "BET_WIN", "CASINO_WIN", "BET_REFUND", "CASINO_REFUND"] } },
          _sum: { amount: true },
        })
      : Promise.resolve([] as { type: string; _sum: { amount: unknown } }[]),
  ]);
  const ips = [...new Set(acts.map((a) => a.ip).filter((x): x is string => !!x))];
  const local = (ip: string) => ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  const publicIps = ips.filter((ip) => !local(ip));
  const [sharedPhone, sharedIp] = await Promise.all([
    user.phone ? prisma.user.count({ where: { phone: user.phone, id: { not: userId } } }) : Promise.resolve(0),
    publicIps.length
      ? prisma.userActivity.groupBy({ by: ["userId"], where: { ip: { in: publicIps }, userId: { not: userId }, at: { gte: since } } }).then((r) => r.length)
      : Promise.resolve(0),
  ]);
  const sum = (types: string[]) => play.filter((g) => types.includes(g.type)).reduce((s, g) => s + Number(g._sum.amount ?? 0), 0);
  return {
    deposits30: deps._count._all,
    depositAmount30: Number(deps._sum.amount ?? 0),
    failedPix30: failed,
    kycVerified: !!user.kyc?.verified,
    accountAgeDays: (now.getTime() - user.createdAt.getTime()) / 86_400_000,
    hasCpf: !!user.cpf,
    distinctIps30: ips.length,
    sessions30: acts.length,
    turnover30: -sum(["BET_STAKE", "CASINO_BET"]),
    payout30: sum(["BET_WIN", "CASINO_WIN", "BET_REFUND", "CASINO_REFUND"]),
    sharedPhoneUsers: sharedPhone,
    sharedIpUsers: sharedIp,
  };
}

export async function userRisk(userId: string) {
  return riskScore(await loadRiskSignals(userId));
}
