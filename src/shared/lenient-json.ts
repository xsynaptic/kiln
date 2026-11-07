import { z } from "zod";

export function textOr(fallback: string) {
  return z
    .unknown()
    .transform((value) => (typeof value === "string" ? value : fallback))
    .default(fallback);
}

export const optionalText = z
  .unknown()
  .transform((value) => (typeof value === "string" ? value : undefined))
  .optional();

export function parseJson(raw: string | undefined): unknown {
  if (raw === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function parseEach<Item>(schema: z.ZodType<Item>, parsed: unknown): Array<Item> {
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.flatMap((item) => {
    const result = schema.safeParse(item);
    return result.success ? [result.data] : [];
  });
}
