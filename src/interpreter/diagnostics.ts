/** A problem found in a learner's source, located by its 0-based row. */
export interface SourceDiagnostic {
  row: number;
  message: string;
}

const sourceIndices = new WeakMap<SourceDiagnostic, number>();

export function sourceDiagnostic(row: number, index: number, message: string): SourceDiagnostic {
  const diagnostic = { row, message };
  sourceIndices.set(diagnostic, index);
  return diagnostic;
}

export function diagnosticIndex(diagnostic: SourceDiagnostic): number | undefined {
  return sourceIndices.get(diagnostic);
}

/** Rejects a program before it runs. */
export class CompileError extends Error {
  constructor(readonly diagnostics: SourceDiagnostic[]) {
    super(diagnostics.map((diagnostic) => `${diagnostic.row + 1}: ${diagnostic.message}`).join('\n'));
    this.name = 'CompileError';
  }
}
