import { Random } from '../app/utils/random';
import { traceJavaProgram } from '../java/trace';
import { extractBlanks, removeBlankMarkers } from './fillInBlank/blanks';
import { getProblemProgram } from './problemData';
import type { TraceItem, TraceItemVariable, TurtleTrace } from './trace';

export interface InstantiatedProblem {
  /**
   * The program to be displayed to the user. Blanks of fill-in-the-blank problems are shown as placeholders.
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
   * The `toString()` of the exception that ended the program, if one escaped `main`.
   */
  uncaughtException: string | undefined;

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
    ...traceJavaProgram(removeBlankMarkers(displayProgramTemplate), displayBlanks.programWithPlaceholders),
    blankAnswers: displayBlanks.answers,
    displayProgramTemplate,
  };
}
