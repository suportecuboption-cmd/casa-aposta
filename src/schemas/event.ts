import { z } from "zod";

const odd = z
  .number({ invalid_type_error: "Informe a odd (número)" })
  .min(1.01, "Odd mínima é 1,01")
  .max(1000, "Odd máxima é 1000");

const fields = {
  league: z.string().trim().min(1, "Informe o campeonato").max(80),
  homeTeam: z.string().trim().min(1, "Informe o time da casa").max(60),
  awayTeam: z.string().trim().min(1, "Informe o time visitante").max(60),
  startsAt: z.coerce.date({ errorMap: () => ({ message: "Informe data e hora válidas" }) }),
  oddsHome: odd,
  oddsDraw: odd.nullable(), // null = mercado sem empate (ex.: tênis, basquete)
  oddsAway: odd,
  isLive: z.boolean(),
};

const differentTeams = (v: { homeTeam?: string; awayTeam?: string }) =>
  !v.homeTeam || !v.awayTeam || v.homeTeam.toLowerCase() !== v.awayTeam.toLowerCase();
const differentTeamsMsg = { message: "Os times precisam ser diferentes", path: ["awayTeam"] };

export const createEventSchema = z
  .object({
    ...fields,
    oddsDraw: fields.oddsDraw.optional(),
    isLive: fields.isLive.default(false),
  })
  .refine(differentTeams, differentTeamsMsg);

export const updateEventSchema = z
  .object(fields)
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "Nada para atualizar" })
  .refine(differentTeams, differentTeamsMsg);

export type CreateEventInput = z.infer<typeof createEventSchema>;
export type UpdateEventInput = z.infer<typeof updateEventSchema>;
