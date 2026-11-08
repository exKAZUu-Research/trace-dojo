import { z } from 'zod';

import type { ChallengeTarget } from './types';

export const generatedProblemSchema = z
  .object({
    version: z.literal(1),
    displayProgram: z.string().min(1).max(20_000),
    finalBoard: z.string(),
    finalTurtles: z.array(
      z.object({ x: z.number(), y: z.number(), color: z.string(), dir: z.enum(['N', 'E', 'S', 'W']) })
    ),
  })
  .strict();
export type GeneratedProblemSnapshot = z.infer<typeof generatedProblemSchema>;

/** Persist only the displayed program and judging target. Source/seed or policy edits must never change an admitted exercise. */
export function snapshotOf(problem: ChallengeTarget & { displayProgram: string }): GeneratedProblemSnapshot {
  return generatedProblemSchema.parse({
    version: 1,
    displayProgram: problem.displayProgram,
    finalBoard: problem.finalBoard,
    finalTurtles: problem.finalTurtles,
  });
}
