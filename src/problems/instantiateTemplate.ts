import { Random } from '../app/utils/random';
import type { ProgramTrace } from '../interpreter/interpreter';
import { extractBlanks, removeBlankMarkers } from './fillInBlank/blanks';
import type { ProblemRunner } from './problemRunner';

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

/** @param variableSeed Decides the random numbers, so a session shows the same program whenever it is opened. */
export async function instantiateTemplate(
  runner: ProblemRunner,
  template: string,
  variableSeed: string
): Promise<InstantiatedProblem> {
  const random = new Random(variableSeed);
  const displayProgramTemplate = template.replaceAll(randomNumberRegex, (_, min: string, max: string) =>
    random.getInteger(Number(min), Number(max)).toString()
  );
  const displayBlanks = extractBlanks(displayProgramTemplate);
  return {
    ...(await runner.traceProgram(
      'java',
      removeBlankMarkers(displayProgramTemplate),
      displayBlanks.programWithPlaceholders
    )),
    blankAnswers: displayBlanks.answers,
    displayProgramTemplate,
  };
}
