/** An `// atomic` annotation, with its offset in the source. */
export interface TraceAnnotation {
  index: number;
  text: string;
}

/** Matches the annotation a line comment ends with, which may follow an ordinary remark. */
const traceAnnotationPattern = /\/\/[ \t]*atomic[ \t]*$/;

/** Makes a model program record its steps, except inside the methods declared on `atomicRows`. */
export interface TraceOptions {
  atomicRows: ReadonlySet<number>;
}

export const misplacedAtomicMessage =
  '// atomic は、メソッドや関数を宣言する行（本体の { がある行まで）に付けてください。';

/** The annotations that the given line comments end with. */
export function traceAnnotationsIn(lineComments: Iterable<TraceAnnotation>): TraceAnnotation[] {
  return [...lineComments].flatMap(({ index, text }) => {
    const annotation = traceAnnotationPattern.exec(text);
    return annotation ? [{ index: index + annotation.index, text: annotation[0] }] : [];
  });
}

/** The rows of `// atomic` comments, which mark the methods whose calls each count as part of the caller's step. */
export function atomicRowsOf(source: string, annotations: TraceAnnotation[]): Set<number> {
  return new Set(annotations.map(({ index }) => source.slice(0, index).split('\n').length - 1));
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
