import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";
import { registerSchema, loginSchema } from "../schemas/index.js";
import { recordActivity } from "../services/activity.js";

export async function authRoutes(app: FastifyInstance) {
  app.post("/auth/register", async (req, reply) => {
    const body = registerSchema.parse(req.body);
    if (await prisma.user.findUnique({ where: { email: body.email } }))
      throw new AppError("E-mail já cadastrado", 409, "CONFLICT");
    if (await prisma.user.findUnique({ where: { cpf: body.cpf } }))
      throw new AppError("CPF já cadastrado", 409, "CONFLICT");

    const passwordHash = await bcrypt.hash(body.password, 10);
    let user;
    try {
      user = await prisma.user.create({
        data: {
          email: body.email,
          passwordHash,
          displayName: body.displayName,
          cpf: body.cpf,
          phone: body.phone,
          wallet: { create: {} },
        },
      });
    } catch (e: any) {
      // Corrida entre a checagem e o insert (índice único de e-mail/CPF).
      if (e?.code === "P2002") {
        const target = Array.isArray(e?.meta?.target) ? e.meta.target.join(",") : String(e?.meta?.target ?? "");
        throw new AppError(target.includes("cpf") ? "CPF já cadastrado" : "E-mail já cadastrado", 409, "CONFLICT");
      }
      throw e;
    }
    recordActivity(user.id, "register", { ip: req.ip, userAgent: req.headers["user-agent"] });
    const token = await reply.jwtSign({ sub: user.id, role: user.role, email: user.email });
    return { token, user: { id: user.id, email: user.email, role: user.role } };
  });

  app.post("/auth/login", async (req, reply) => {
    const body = loginSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: body.email } });
    if (!user || !(await bcrypt.compare(body.password, user.passwordHash))) {
      throw new AppError("Credenciais inválidas", 401, "UNAUTHORIZED");
    }
    if (!user.isActive) throw new AppError("Conta suspensa", 403, "FORBIDDEN");
    if (user.role === "PLAYER") recordActivity(user.id, "login", { ip: req.ip, userAgent: req.headers["user-agent"] });
    const token = await reply.jwtSign({
      sub: user.id,
      role: user.role,
      email: user.email,
    });
    return { token, user: { id: user.id, email: user.email, role: user.role } };
  });

  app.get("/auth/me", async (req) => {
    const jwt = await app.authenticate(req);
    const user = await prisma.user.findUnique({
      where: { id: jwt.sub },
      include: { wallet: true, kyc: true },
    });
    if (!user) throw new AppError("Utilizador não encontrado", 404);
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      wallet: user.wallet,
      kyc: user.kyc,
    };
  });
}