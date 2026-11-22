import { z } from 'zod';

import { extractBlanks, removeBlankMarkers } from '../fillInBlank/blanks';
import type { JavaChallengeDefinition } from '../javaChallenges/types';
import { challengeBases } from './definitions';
import { applyChallengeEdit } from './edits';
import { challengeBaseSchema } from './schema';
import type { ChallengeEdit } from './types';

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
    const variants = [
      ...base.blanks.map((edit) => ({ id: `${base.id}Blank${edit.id}`, ...blankVariant(base.java, edit) })),
      ...base.bugs.map((edit) => ({
        id: `${base.id}Bug${edit.id}`,
        problemFormat: 'bugFix' as const,
        starterProgram: applyChallengeEdit(base.java, edit),
        bugKind: edit.kind,
      })),
    ];
    for (const { id, ...variant } of variants) {
      if (registeredIds.has(id)) throw new Error(`Duplicate challenge ID: ${id}`);
      registeredIds.add(id);
      definitions[id] = { ...target, ...variant };
    }
  }
  return definitions;
}

function blankVariant(java: string, edit: ChallengeEdit): { problemFormat: 'fillInBlank'; starterProgram: string } {
  const starterProgram = applyChallengeEdit(java, edit);
  if (extractBlanks(starterProgram).answers.length !== 1 || removeBlankMarkers(starterProgram).trim() !== java.trim())
    throw new Error(`Invalid challenge blank: ${edit.id}`);
  return { problemFormat: 'fillInBlank', starterProgram };
}
