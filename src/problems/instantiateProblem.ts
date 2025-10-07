import { Random } from '../app/utils/random';

import type { LanguageId, ProblemId } from './problemData';
import { problemIdToLanguageIdToProgram } from './problemData';
import { type TraceItem, type TraceItemVariable, traceProgram } from './traceProgram';

export type InstantiatedProblem = {
  /**
   * The language ID of the program.
   */
  languageId: LanguageId;

  /**
   * The program to be displayed to the user.
   */
  displayProgram: string;

  /**
   * The program to be executable via `eval()`. For debugging.
   */
  executableCode: string;

  /**
   * The trace items of the program.
   */
  traceItems: TraceItem[];

  /**
   * The mapping from statement ID to line index.
   */
  sidToLineIndex: Map<number, number>;

  /**
   * The mapping from caller ID to line index.
   */
  callerIdToLineIndex: Map<number, number>;

  /**
   * The variables of the final state
   */
  finalVars: TraceItemVariable;
};

const randomNumberRegex = /<(\d+)-(\d+)>/g;

export function instantiateProblem(
  problemId: string,
  languageId: LanguageId,
  variableSeed: string
): InstantiatedProblem | undefined {
  const template = problemIdToLanguageIdToProgram[problemId as ProblemId];
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!template?.[languageId]) return;

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
