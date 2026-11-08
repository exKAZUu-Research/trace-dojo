import { Random } from '../app/utils/random';
import { type ProgramTrace, traceProgram } from '../interpreter/program';
import { extractBlanks, removeBlankMarkers } from './fillInBlank/blanks';

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

export function instantiateTemplate(template: string, variableSeed: string): InstantiatedProblem {
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
