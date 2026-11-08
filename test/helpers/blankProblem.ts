import { Random } from '../../src/app/utils/random';
import { traceProgram } from '../../src/interpreter/program';
import { extractBlanks, removeBlankMarkers } from '../../src/problems/fillInBlank/blanks';
import { instantiateProblem as instantiateRegular } from '../../src/problems/instantiateProblem';
import { blankPrograms } from '../fixtures/blankPrograms';

export function instantiateProblem(id: string, seed: string): ReturnType<typeof instantiateRegular> {
  const template = blankPrograms[id];
  if (!template) return instantiateRegular(id, seed);
  const random = new Random(seed);
  const displayProgramTemplate = template
    .trim()
    .replaceAll(/<(\d+)-(\d+)>/g, (_, min: string, max: string) =>
      random.getInteger(Number(min), Number(max)).toString()
    );
  const blanks = extractBlanks(displayProgramTemplate);
  return {
    ...traceProgram('java', removeBlankMarkers(displayProgramTemplate), blanks.programWithPlaceholders),
    blankAnswers: blanks.answers,
    displayProgramTemplate,
  };
}
