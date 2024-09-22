import { Random } from '../app/lib/random';

import type { LanguageId, ProblemId } from './problemData';
import { problemIdToLanguageIdToProgram } from './problemData';
import { type TraceItem, traceProgram } from './traceProgram';

export type Problem = {
  /**
   * The language ID of the program.
   */
  languageId: LanguageId;

  /**
   * The program to be displayed to the user.
   */
  displayProgram: string;

  /**
   * The trace items of the program.
   */
  traceItems: TraceItem[];

  /**
   * The mapping from statement ID to line index.
   */
  sidToLineIndex: Map<number, number>;

  /**
   * The statement IDs of the checkpoints.
   */
  checkpointSids: number[];
};

const randomNumberRegex = /<(\d+)-(\d+)>/g;

export function generateProblem(problemId: string, languageId: LanguageId, variableSeed: string): Problem | undefined {
  const template = problemIdToLanguageIdToProgram[problemId as ProblemId];
  if (!template) return;

  const random = new Random(variableSeed);
  const generatedNumbers: number[] = [];
  const instrumented = template.instrumented.replaceAll(randomNumberRegex, (_, min, max) => {
    const randomNumber = random.getInteger(Number(min), Number(max));
    generatedNumbers.push(randomNumber);
    return randomNumber.toString();
  });

  // 言語が変わっても、乱数埋め込み箇所の出現順序は変わらないという前提を置く。
  let index = 0;
  const rawDisplayProgram = template[languageId].replaceAll(randomNumberRegex, () =>
    generatedNumbers[index++].toString()
  );
  return traceProgram(instrumented, rawDisplayProgram, languageId);
}
