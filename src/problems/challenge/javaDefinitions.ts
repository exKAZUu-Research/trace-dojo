import { z } from 'zod';
import { extractBlanks } from '../fillInBlank/blanks';
import type { JavaChallengeDefinition } from '../javaChallenges/types';
import { traceProgram } from '../traceProgram';
import { challengeBaseSchema } from './schema';
import { challengeBases } from './definitions';
import { applyChallengeEdit } from './edits';

const directionSchema = z.enum(['N', 'E', 'S', 'W']);

export const independentJavaChallengeDefinitions: Record<string, JavaChallengeDefinition> = {};
const registeredIds = new Set<string>();
for (const base of z.array(challengeBaseSchema).parse(challengeBases)) {
  if (registeredIds.has(base.id)) throw new Error(`Duplicate challenge ID: ${base.id}`);
  registeredIds.add(base.id);
  let trace: ReturnType<typeof traceProgram>;
  try {
    trace = traceProgram(base.instrumented, base.java, 'java');
  } catch (error) {
    throw new Error(`Invalid challenge trace: ${base.id}`, { cause: error });
  }
  const target = {
    title: base.title,
    courseId: base.courseId,
    lectureIndex: base.lectureIndex,
    correctProgram: base.java.trim(),
    finalBoard: trace.finalBoard,
    finalTurtles: trace.finalTurtles.map((turtle) => ({ ...turtle, dir: directionSchema.parse(turtle.dir) })),
  };
  for (const format of ['fillInBlank', 'bugFix'] as const) {
    for (const edit of format === 'fillInBlank' ? base.blanks : base.bugs) {
      const id = `${base.id}${format === 'fillInBlank' ? 'Blank' : 'Bug'}${edit.id}`;
      if (registeredIds.has(id)) throw new Error(`Duplicate challenge ID: ${id}`);
      registeredIds.add(id);
      const starterProgram = applyChallengeEdit(base.java, edit);
      if (format === 'fillInBlank') {
        const blanks = extractBlanks(starterProgram);
        if (
          blanks.answers.length !== 1 ||
          starterProgram.replaceAll(/@\[([\s\S]*?)\]@/g, '$1').trim() !== target.correctProgram
        )
          throw new Error(`Invalid challenge blank: ${id}`);
      }
      independentJavaChallengeDefinitions[id] = {
        ...target,
        problemFormat: format,
        starterProgram,
        ...('kind' in edit ? { bugKind: z.enum(['logical', 'syntax']).parse(edit.kind) } : {}),
      };
    }
  }
}
