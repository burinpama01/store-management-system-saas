// Task 9/D (v0.34.0) — AI structured-output schemas (zod, strict).
// The model may only answer inside this shape; anything else is rejected
// before it can reach the caller (plan: "structured output invalid").
import { z } from "zod";

export const DeviceAdviceSchema = z
  .object({
    summary: z.string().max(240),
    steps: z.array(z.string().max(180)).max(5),
    requiresConfirmation: z.boolean(),
  })
  .strict();

export type DeviceAdvice = z.infer<typeof DeviceAdviceSchema>;