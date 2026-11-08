import { Random } from '../app/utils/random';
import { type ProgramTrace, traceProgram } from '../interpreter/program';
import { extractBlanks, removeBlankMarkers } from './fillInBlank/blanks';
import { getProblemProgram } from './problemData';

export interface InstantiatedProblem extends ProgramTrace {
  /**
   * The model answers of blanks. Empty for problems without blanks.
   */
  blankAnswers: string[];

  /**
   * The program whose blanks are kept as `@[...]@` markers and whose random numbers are instantiated.
   */
  displayProgramTemplate: string;
}

const randomNumberRegex = /<(\d+)-(\d+)>/g;

export function isFillInBlankProblem(problemId: string): boolean {
  return extractBlanks(getProblemProgram(problemId) ?? '').answers.length > 0;
}

export function instantiateProblem(problemId: string, variableSeed: string): InstantiatedProblem | undefined {
  const template = getProblemProgram(problemId);
  if (!template) return;

  const random = new Random(variableSeed);
  const displayProgramTemplate = template.replaceAll(randomNumberRegex, (_, min: string, max: string) =>
    random.getInteger(Number(min), Number(max)).toString()
  );
  const displayBlanks = extractBlanks(displayProgramTemplate);
  return {
    ...traceProgram('java', removeBlankMarkers(displayProgramTemplate), displayBlanks.programWithPlaceholders),
    blankAnswers: displayBlanks.answers,
    displayProgramTemplate,
  };
}
