import { z } from 'zod';

const expiredSessionErrorSchema = z.object({ data: z.object({ code: z.literal('NOT_FOUND') }) });

export function isProblemSessionExpired(error: unknown): boolean {
  return expiredSessionErrorSchema.safeParse(error).success;
}
