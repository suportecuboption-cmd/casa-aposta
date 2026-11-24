import { z } from "zod";

export const gamesQuerySchema = z.object({
  category: z.string().min(1).max(40).optional(),
  provider: z.string().min(1).max(40).optional(),
});

export type GamesQuery = z.infer<typeof gamesQuerySchema>;
