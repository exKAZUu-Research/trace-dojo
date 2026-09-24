import { Random } from '../app/utils/random';

import { extractBlanks, fillBlanks } from './fillInBlank/blanks';
import type { LanguageId, ProblemId } from './problemData';
import { problemIdToLanguageIdToProgram } from './problemData';
import { type TraceItem, type TraceItemVariable, traceProgram, type TurtleTrace } from './traceProgram';

export interface InstantiatedProblem {
  /**
   * The language ID of the program.
   */
  languageId: LanguageId;

  /**
   * The program to be displayed to the user. Blanks of fill-in-the-blank problems are shown as placeholders.
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

  /**
   * The board of the final state.
   */
  finalBoard: string;

  /**
   * The turtles of the final state.
   */
  finalTurtles: TurtleTrace[];

  /**
   * The model answers of blanks. Empty for problems without blanks.
   */
  blankAnswers: string[];

  /**
   * The display-language program whose blanks are kept as `@[...]@` markers and whose random numbers are instantiated.
   */
  displayProgramTemplate: string;

  /**
   * The instrumented program whose blanks are kept as `@[...]@` markers and whose random numbers are instantiated.
   */
  instrumentedTemplate: string;
}

const randomNumberRegex = /<(\d+)-(\d+)>/g;

export function isFillInBlankProblem(problemId: string): boolean {
  const template = problemIdToLanguageIdToProgram[problemId as ProblemId];
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  return extractBlanks(template?.java ?? '').answers.length > 0;
}

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
  const instrumentedTemplate = template.instrumented.replaceAll(randomNumberRegex, (_, min, max) => {
    const randomNumber = random.getInteger(Number(min), Number(max));
    generatedNumbers.push(randomNumber);
    return randomNumber.toString();
  });

  // 言語が変わっても、乱数埋め込み箇所の出現順序は変わらないという前提を置く。
  let index = 0;
  const displayProgramTemplate = template[languageId].replaceAll(randomNumberRegex, () =>
    generatedNumbers[index++].toString()
  );
  const displayBlanks = extractBlanks(displayProgramTemplate);
  const instrumentedBlanks = extractBlanks(instrumentedTemplate);
  const problem = traceProgram(
    fillBlanks(instrumentedTemplate, instrumentedBlanks.answers),
    displayBlanks.answers.length > 0 ? displayBlanks.programWithPlaceholders : displayProgramTemplate,
    languageId
  );
  return {
    ...problem,
    blankAnswers: displayBlanks.answers,
    displayProgramTemplate,
    instrumentedTemplate,
  };
}
