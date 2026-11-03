/** A problem found in a learner's source, located by its 0-based row. */
export interface JavaSourceDiagnostic {
  row: number;
  message: string;
}

/** Rejects a program before it runs, as javac would. */
export class CompileError extends Error {
  constructor(readonly diagnostics: JavaSourceDiagnostic[]) {
    super(diagnostics.map((diagnostic) => `${diagnostic.row + 1}: ${diagnostic.message}`).join('\n'));
    this.name = 'CompileError';
  }
}
