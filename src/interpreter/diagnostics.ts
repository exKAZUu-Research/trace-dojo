/** A problem found in a learner's source, located by its 0-based row. */
export interface SourceDiagnostic {
  row: number;
  message: string;
}

/** Rejects a program before it runs. */
export class CompileError extends Error {
  constructor(readonly diagnostics: SourceDiagnostic[]) {
    super(diagnostics.map((diagnostic) => `${diagnostic.row + 1}: ${diagnostic.message}`).join('\n'));
    this.name = 'CompileError';
  }
}
