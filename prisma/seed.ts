import { PrismaClient, Role } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const adminEmail = process.env.ADMIN_BOOTSTRAP_EMAIL ?? "admin@lab.local";
  const adminPass = process.env.ADMIN_BOOTSTRAP_PASSWORD ?? "Admin123!";
  const hash = await bcrypt.hash(adminPass, 10);

  await prisma.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      email: adminEmail,
      passwordHash: hash,
      role: Role.ADMIN,
      displayName: "Admin Lab",
      wallet: { create: {} },
    },
  });

  // Jogos e provedores do cassino não são semeados: vêm todos da PlayFivers
  // (admin → Integrações → Sincronizar jogos).

  const bannerCount = await prisma.banner.count();
  if (bannerCount === 0) {
    await prisma.banner.createMany({
      data: [
        {
          placement: "MAIN",
          title: "O jogo começa aqui",
          subtitle: "Super Múltipla · Super Odds · Super Substituição",
          bgColor: "linear-gradient(120deg,#2a0a0e 0%,#7a1420 55%,#b31320 100%)",
          ctaText: "Apostar agora",
          ctaLink: "/app/#esportes",
          sortOrder: 0,
        },
        {
          placement: "MAIN",
          title: "Cassino ao vivo 24h",
          subtitle: "Roleta, Blackjack e os maiores provedores do mercado",
          bgColor: "linear-gradient(120deg,#07150f 0%,#0f5132 55%,#14cd7a 100%)",
          ctaText: "Jogar cassino",
          ctaLink: "/app/#cassino",
          sortOrder: 1,
        },
        {
          placement: "MAIN",
          title: "Bônus de boas-vindas",
          subtitle: "Deposite via PIX e turbine seu primeiro depósito",
          bgColor: "linear-gradient(120deg,#160f2e 0%,#3b1d8f 55%,#6d3bff 100%)",
          ctaText: "Depositar",
          ctaLink: "/app/#deposito",
          sortOrder: 2,
        },
        {
          placement: "SIDE",
          title: "Tá com dúvida?",
          subtitle: "Fale com a gente — atendimento rápido e humano",
          bgColor: "linear-gradient(135deg,#2a0a0e 0%,#b31320 100%)",
          ctaText: "Abrir suporte",
          ctaLink: "#",
          sortOrder: 0,
        },
        {
          placement: "SIDE",
          title: "Seu palpite em campo",
          subtitle: "As melhores odds do jogo esperam por você",
          bgColor: "linear-gradient(135deg,#0f0f22 0%,#6d3bff 100%)",
          ctaText: "Apostar",
          ctaLink: "/app/#esportes",
          sortOrder: 1,
        },
      ],
    });
  }

  const count = await prisma.sportEvent.count();
  if (count === 0) {
    await prisma.sportEvent.createMany({
      data: [
        {
          league: "Brasileirão Série A",
          homeTeam: "Flamengo",
          awayTeam: "Palmeiras",
          startsAt: new Date(Date.now() + 3_600_000),
          oddsHome: 2.1,
          oddsDraw: 3.4,
          oddsAway: 3.2,
        },
        {
          league: "Premier League",
          homeTeam: "Arsenal",
          awayTeam: "Chelsea",
          startsAt: new Date(Date.now() + 86_400_000),
          isLive: true,
          oddsHome: 1.9,
          oddsDraw: 3.6,
          oddsAway: 4.1,
        },
      ],
    });
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });