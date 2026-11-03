/** A `// step` or `// caller` annotation, with its offset in the source. */
export interface TraceAnnotation {
  index: number;
  text: string;
}

export interface Annotations {
  stepIdByRow: Map<number, number>;
  callerIdByRow: Map<number, number>;
}

/** Matches the annotations a line comment ends with, which may follow an ordinary remark. */
export const traceAnnotationPattern =
  /\/\/[ \t]*(?:step(?:[ \t]*:[ \t]*\d+)?|caller)(?:[ \t]*\/\/[ \t]*(?:step(?:[ \t]*:[ \t]*\d+)?|caller))*[ \t]*$/;

/** The annotations that the given line comments end with. */
export function traceAnnotationsIn(lineComments: Iterable<TraceAnnotation>): TraceAnnotation[] {
  return [...lineComments].flatMap(({ index, text }) => {
    const annotation = traceAnnotationPattern.exec(text);
    return annotation ? [{ index: index + annotation.index, text: annotation[0] }] : [];
  });
}

/**
 * Reads `// step` and `// caller` comments, which number the rows a trace item or a call refers to. A step's ID
 * counts up from the previous one unless written as `// step: n`.
 */
export function readAnnotations(source: string, annotations: TraceAnnotation[]): Annotations {
  const stepIdByRow = new Map<number, number>();
  const callerIdByRow = new Map<number, number>();
  let lastStepId = 0;
  let lastCallerId = 0;
  for (const { index, text } of annotations) {
    const row = source.slice(0, index).split('\n').length - 1;
    for (const [, kind, id] of text.matchAll(/(step|caller)(?:[ \t]*:[ \t]*(\d+))?/g)) {
      if (kind === 'step') {
        lastStepId = id ? Number(id) : lastStepId + 1;
        stepIdByRow.set(row, lastStepId);
      } else {
        lastCallerId++;
        callerIdByRow.set(row, lastCallerId);
      }
    }
  }
  return { stepIdByRow, callerIdByRow };
}

/** Removes the annotations and the blanks before them, keeping every row in place. */
export function removeAnnotations(source: string, annotations: TraceAnnotation[]): string {
  let program = '';
  let copied = 0;
  for (const { index, text } of annotations) {
    program += source.slice(copied, index).replace(/[ \t]+$/, '');
    copied = index + text.length;
  }
  return program + source.slice(copied);
}
