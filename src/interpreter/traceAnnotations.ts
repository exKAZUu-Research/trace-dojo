/** An `// atomic` annotation, with its offset in the source. */
export interface TraceAnnotation {
  index: number;
  text: string;
}

/** Matches the annotation a line comment ends with, which may follow an ordinary remark. */
const traceAnnotationPattern = /\/\/[ \t]*atomic[ \t]*$/;

/** Makes a model program record its steps, except inside the methods its `// atomic` annotations mark. */
export interface TraceOptions {
  /** The offset of each annotation by its row, which holds at most one since an annotation ends its line. */
  atomicAnnotations: ReadonlyMap<number, number>;
}

export const misplacedAtomicMessage =
  '// atomic は、メソッド・コンストラクタ・関数を宣言する行（本体の { がある行まで）に付けてください。';

/**
 * The annotations that the given line comments end with.
 *
 * @param pattern Matches the annotation at the end of a comment, for languages whose line comments differ from `//`.
 */
export function traceAnnotationsIn(
  lineComments: Iterable<TraceAnnotation>,
  pattern = traceAnnotationPattern
): TraceAnnotation[] {
  return [...lineComments].flatMap(({ index, text }) => {
    const annotation = pattern.exec(text);
    return annotation ? [{ index: index + annotation.index, text: annotation[0] }] : [];
  });
}

/** The offsets of `// atomic` comments by row, which mark the methods whose calls each count as part of the caller's step. */
export function atomicAnnotationsOf(source: string, annotations: TraceAnnotation[]): Map<number, number> {
  return new Map(annotations.map(({ index }) => [source.slice(0, index).split('\n').length - 1, index]));
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
