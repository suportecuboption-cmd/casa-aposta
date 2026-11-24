import { z } from "zod";

export const launchSchema = z.object({
  gameId: z.string().min(1),
  mode: z.enum(["real", "demo"]).default("real"),
});
