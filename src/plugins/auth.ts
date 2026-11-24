import type { FastifyInstance, FastifyRequest } from "fastify";
import { Role } from "@prisma/client";
import { AppError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import { recordActivity } from "../services/activity.js";

export type JwtUser = {
  sub: string;
  role: Role;
  email: string;
};

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, roles?: Role[]) => Promise<JwtUser>;
  }
}

function jwtPayload(req: FastifyRequest): JwtUser {
  return req.user as JwtUser;
}

export function registerAuth(app: FastifyInstance) {
  app.decorate(
    "authenticate",
    async (req: FastifyRequest, roles?: Role[]) => {
      try {
        await req.jwtVerify();
      } catch {
        throw new AppError("Não autorizado", 401, "UNAUTHORIZED");
      }
      const claims = jwtPayload(req);
      // Confere no banco a cada requisição: bloqueio e mudança de papel valem na hora,
      // mesmo para quem ainda tem um token antigo (os tokens não expiram).
      const user = await prisma.user.findUnique({
        where: { id: claims.sub },
        select: { id: true, email: true, role: true, isActive: true },
      });
      if (!user) throw new AppError("Não autorizado", 401, "UNAUTHORIZED");
      if (!user.isActive) throw new AppError("Conta suspensa", 403, "FORBIDDEN");
      if (roles?.length && !roles.includes(user.role)) {
        throw new AppError("Sem permissão", 403, "FORBIDDEN");
      }
      // Sessão em uso conta como acesso (dashboard → Usuários ativos), com limite de frequência.
      if (user.role === Role.PLAYER) recordActivity(user.id, "session", { ip: req.ip, userAgent: req.headers["user-agent"] });
      return { sub: user.id, role: user.role, email: user.email };
    },
  );
}