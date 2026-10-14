import { z } from 'zod';

import { TURTLE_GRAPHICS_BOARD_COLUMNS, TURTLE_GRAPHICS_BOARD_ROWS } from '../../constants';
import { extractBlanks } from '../fillInBlank/blanks';
import { buildJavaJudgeProgram, findForbiddenJavaPattern, MAX_JAVA_PROGRAM_LENGTH } from '../fillInBlank/javaProgram';
import { charToColor } from '../traceProgram';

import { javaChallengeDefinitions } from './definitions';
import type { JavaChallengeFormat, JavaChallengeTarget } from './types';

export interface InstantiatedJavaChallenge extends JavaChallengeTarget {
  displayProgram: string;
}

const boardRowPattern = new RegExp(`^[${Object.keys(charToColor).join('')}]{${TURTLE_GRAPHICS_BOARD_COLUMNS}}$`);
const colorSchema = z.string().refine((color) => color.length === 1 && color in charToColor);
const definitionSchema = z.object({
  sourceProblemId: z.string().min(1).optional(),
  authoringSeed: z.string().min(1).optional(),
  title: z.string().min(1),
  courseId: z.enum(['tuBeginner1', 'tuBeginner2', 'test']),
  lectureIndex: z.number().int().min(0).max(7),
  problemFormat: z.enum(['fillInBlank', 'bugFix']),
  correctProgram: z.string().trim().min(1).max(MAX_JAVA_PROGRAM_LENGTH),
  starterProgram: z.string().min(1).max(MAX_JAVA_PROGRAM_LENGTH),
  finalBoard: z.string().refine((board) => {
    const rows = board.split('\n');
    return rows.length === TURTLE_GRAPHICS_BOARD_ROWS && rows.every((row) => boardRowPattern.test(row));
  }),
  finalTurtles: z.array(
    z.object({
      x: z
        .number()
        .int()
        .min(0)
        .max(TURTLE_GRAPHICS_BOARD_COLUMNS - 1),
      y: z
        .number()
        .int()
        .min(0)
        .max(TURTLE_GRAPHICS_BOARD_ROWS - 1),
      color: colorSchema,
      dir: z.enum(['N', 'E', 'S', 'W']),
    })
  ),
  bugKind: z.enum(['logical', 'syntax']).optional(),
});

export const instantiateJavaChallenge = (problemId: string, format: JavaChallengeFormat): InstantiatedJavaChallenge => {
  const definition = definitionSchema.parse(javaChallengeDefinitions[problemId]);
  if (definition.problemFormat !== format) throw new Error(`Wrong challenge format: ${problemId}`);
  if (
    findForbiddenJavaPattern(definition.correctProgram) ||
    buildJavaJudgeProgram(definition.correctProgram, '__MODEL_VALIDATION__').program.length > MAX_JAVA_PROGRAM_LENGTH
  )
    throw new Error(`Unsupported challenge model: ${problemId}`);
  if (format === 'bugFix') {
    if (!definition.bugKind || definition.starterProgram.trim() === definition.correctProgram)
      throw new Error(`Invalid bug repair: ${problemId}`);
    return {
      displayProgram: definition.starterProgram,
      finalBoard: definition.finalBoard,
      finalTurtles: definition.finalTurtles,
    };
  }
  const blanks = extractBlanks(definition.starterProgram);
  const restored = definition.starterProgram.replaceAll(/@\[([\s\S]*?)\]@/g, '$1').trim();
  if (blanks.answers.length === 0 || restored !== definition.correctProgram)
    throw new Error(`Invalid blank challenge: ${problemId}`);
  return {
    displayProgram: blanks.programWithPlaceholders,
    finalBoard: definition.finalBoard,
    finalTurtles: definition.finalTurtles,
  };
};
