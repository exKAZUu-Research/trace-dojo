import { z } from 'zod';

import { extractBlanks, removeBlankMarkers } from '../fillInBlank/blanks';
import type { JavaChallengeDefinition } from '../javaChallenges/types';
import { challengeBases } from './definitions';
import { applyChallengeEdit } from './edits';
import { challengeBaseSchema } from './schema';

/** The state in which a base's program ends, which every blank and bug of the base must reproduce. */
export type ChallengeTarget = Pick<JavaChallengeDefinition, 'finalBoard' | 'finalTurtles'>;

export const parsedChallengeBases = z.array(challengeBaseSchema).parse(challengeBases);

/** @param targets The target of each base by its ID. */
export function buildIndependentJavaChallengeDefinitions(
  targets: Readonly<Partial<Record<string, ChallengeTarget>>>
): Record<string, JavaChallengeDefinition> {
  const definitions: Record<string, JavaChallengeDefinition> = {};
  const registeredIds = new Set<string>();
  for (const base of parsedChallengeBases) {
    if (registeredIds.has(base.id)) throw new Error(`Duplicate challenge ID: ${base.id}`);
    registeredIds.add(base.id);
    const baseTarget = targets[base.id];
    if (!baseTarget) throw new Error(`Missing challenge target (run "bun run gen-code"): ${base.id}`);
    const target = {
      title: base.title,
      courseId: base.courseId,
      lectureIndex: base.lectureIndex,
      correctProgram: base.java.trim(),
      ...baseTarget,
    };
    for (const format of ['fillInBlank', 'bugFix'] as const) {
      for (const edit of format === 'fillInBlank' ? base.blanks : base.bugs) {
        const id = `${base.id}${format === 'fillInBlank' ? 'Blank' : 'Bug'}${edit.id}`;
        if (registeredIds.has(id)) throw new Error(`Duplicate challenge ID: ${id}`);
        registeredIds.add(id);
        const starterProgram = applyChallengeEdit(base.java, edit);
        if (format === 'fillInBlank') {
          const blanks = extractBlanks(starterProgram);
          if (blanks.answers.length !== 1 || removeBlankMarkers(starterProgram).trim() !== target.correctProgram)
            throw new Error(`Invalid challenge blank: ${id}`);
        }
        definitions[id] = {
          ...target,
          problemFormat: format,
          starterProgram,
          ...('kind' in edit ? { bugKind: z.enum(['logical', 'syntax']).parse(edit.kind) } : {}),
        };
      }
    }
  }
  return definitions;
}
