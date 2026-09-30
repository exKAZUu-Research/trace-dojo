import { z } from 'zod';

const expiredSessionErrorSchema = z.object({ data: z.object({ code: z.literal('NOT_FOUND') }) });

export function isProblemSessionExpired(error: unknown): boolean {
  return expiredSessionErrorSchema.safeParse(error).success;
}

const staleChallengeSessionErrorSchema = z.object({
  data: z.object({ code: z.enum(['CONFLICT', 'NOT_FOUND', 'UNAUTHORIZED']) }),
});

/** The server refuses these on the challenge session's state (advanced, completed, or expired), so the view must be reloaded. */
export function isChallengeSessionStale(error: unknown): boolean {
  return staleChallengeSessionErrorSchema.safeParse(error).success;
}
