import { Random } from '../app/lib/random';

import type { LanguageId, ProgramId } from './problemData';
import { programIdToLanguageIdToProgram } from './problemData';
import { traceProgram, type TraceItem } from './traceProgram';

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

export function generateProblem(programId: ProgramId, languageId: LanguageId, variableSeed: string): Problem {
  const random = new Random(variableSeed);
  const template = programIdToLanguageIdToProgram[programId];
  const generatedNumbers: number[] = [];

  const instrumented = template.instrumented.replaceAll(randomNumberRegex, (match, min, max) => {
    const randomNumber = random.getInteger(Number(min), Number(max));
    generatedNumbers.push(randomNumber);
    return randomNumber.toString();
  });

  let index = 0;
  const rawDisplayProgram = languageId
    ? template[languageId].replaceAll(randomNumberRegex, () => generatedNumbers[index++].toString())
    : '';

  return traceProgram(instrumented, rawDisplayProgram, languageId);
}
