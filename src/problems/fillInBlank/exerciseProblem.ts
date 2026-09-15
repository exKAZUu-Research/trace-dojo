import { randomUUID } from 'node:crypto';

import { extractBlanks, fillBlanks } from './blanks';
import { fillInBlankDefinitions } from './problemData';

import { instantiateProblem } from '@/problems/instantiateProblem';
import { problemIdToLanguageIdToProgram, type ProblemId } from '@/problems/problemData';
import type { TurtleTrace } from '@/problems/traceProgram';

export interface ExerciseDisplay {
  sessionId: number;
  exerciseProblemId: string;
  displayProgram: string;
  blankCount: number;
  expectedBoard: string;
  expectedTurtles: TurtleTrace[];
  completed: boolean;
}

export interface ExerciseSnapshot {
  exerciseProblemId: string;
  baseProblemId: ProblemId;
  programTemplate: string;
  displayProgram: string;
  blankCount: number;
  expectedBoard: string;
  expectedTurtles: TurtleTrace[];
}

export const instantiateExercise = (exerciseProblemId: string): ExerciseSnapshot => {
  const definition = fillInBlankDefinitions[exerciseProblemId];
  if (!definition) throw new Error(`Unknown exercise problem: ${exerciseProblemId}`);
  const baseTemplate = problemIdToLanguageIdToProgram[definition.baseProblemId].java;
  const baseWithoutBlanks = fillBlanks(definition.java, extractBlanks(definition.java).answers);
  if (baseWithoutBlanks.trim() !== baseTemplate.trim()) {
    throw new Error(`Exercise ${exerciseProblemId} differs from its base problem`);
  }
  const base = instantiateProblem(definition.baseProblemId, 'java', randomUUID());
  if (!base) throw new Error(`Cannot instantiate base problem: ${definition.baseProblemId}`);
  let index = 0;
  const programTemplate = definition.java.replaceAll(/<\d+-\d+>/g, () => base.generatedNumbers[index++].toString());
  const blanks = extractBlanks(programTemplate);
  if (blanks.answers.length === 0) throw new Error(`Exercise ${exerciseProblemId} has no blanks`);
  return {
    exerciseProblemId,
    baseProblemId: definition.baseProblemId,
    programTemplate,
    displayProgram: blanks.programWithPlaceholders,
    blankCount: blanks.answers.length,
    expectedBoard: base.finalBoard,
    expectedTurtles: base.finalTurtles,
  };
};
