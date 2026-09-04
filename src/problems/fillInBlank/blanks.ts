/**
 * Blanks are written as `@[ model answer ]@` in problem programs.
 */
const blankRegex = /@\[([\s\S]*?)\]@/g;

export interface ExtractedBlanks {
  /** The program whose blanks are replaced with placeholders such as `【1】`. */
  programWithPlaceholders: string;
  /** The model answers of blanks in order of appearance. */
  answers: string[];
}

export function extractBlanks(program: string): ExtractedBlanks {
  const answers: string[] = [];
  const programWithPlaceholders = program.replaceAll(blankRegex, (_, answer: string) => {
    answers.push(answer.trim());
    return toBlankPlaceholder(answers.length);
  });
  return { programWithPlaceholders, answers };
}

export function fillBlanks(program: string, answers: readonly string[]): string {
  let index = 0;
  return program.replaceAll(blankRegex, () => answers[index++] ?? '');
}

export function toBlankPlaceholder(blankNumber: number): string {
  return `【${blankNumber}】`;
}

/**
 * Normalizes an answer so that differences in whitespace do not matter.
 */
export function normalizeAnswer(answer: string): string {
  // String and char literals keep their contents; only the code around them is normalized.
  return answer
    .split(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part
            .trim()
            .replaceAll(/\s+/g, ' ')
            .replaceAll(/\s?([^\p{L}\p{N}_$])\s?/gu, '$1')
    )
    .join('')
    .trim();
}
