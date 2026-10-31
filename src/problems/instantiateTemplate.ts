import { Random } from '../app/utils/random';
import { extractBlanks, fillBlanks } from './fillInBlank/blanks';
import type { LanguageId } from './problemData';
import { type TraceItem, type TraceItemVariable, traceProgram, type TurtleTrace } from './traceProgram';

export interface InstantiatedProblem {
  languageId: LanguageId;

  displayProgram: string;

  executableCode: string;

  traceItems: TraceItem[];

  sidToLineIndex: Map<number, number>;

  callerIdToLineIndex: Map<number, number>;

  finalVars: TraceItemVariable;

  finalBoard: string;

  finalTurtles: TurtleTrace[];

  blankAnswers: string[];

  displayProgramTemplate: string;

  instrumentedTemplate: string;
}

const randomNumberRegex = /<(\d+)-(\d+)>/g;

export function instantiateTemplate(
  template: Record<LanguageId, string>,
  languageId: LanguageId,
  variableSeed: string
): InstantiatedProblem {
  const random = new Random(variableSeed);
  const generatedNumbers: number[] = [];
  const instrumentedTemplate = template.instrumented.replaceAll(randomNumberRegex, (_, min, max) => {
    const randomNumber = random.getInteger(Number(min), Number(max));
    generatedNumbers.push(randomNumber);
    return randomNumber.toString();
  });

  // Both templates must list random placeholders in the same order.
  let index = 0;
  const displayProgramTemplate = template[languageId].replaceAll(randomNumberRegex, () =>
    generatedNumbers[index++].toString()
  );
  const displayBlanks = extractBlanks(displayProgramTemplate);
  const instrumentedBlanks = extractBlanks(instrumentedTemplate);
  // Grading fills the student's answers into the instrumented template by position, so the counts must match.
  if (displayBlanks.answers.length !== instrumentedBlanks.answers.length) {
    throw new Error(`Blank counts differ between the ${languageId} and instrumented templates`);
  }
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
