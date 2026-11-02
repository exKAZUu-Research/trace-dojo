import { compileJavaProgram } from '../../scripts/javaDiagnostics/localCompiler';
import type { JavaExecutor } from '../../src/problems/fillInBlank/javaExecutors';

export const localCompileOnlyExecutor: JavaExecutor = {
  name: 'local-compile-only',
  async execute(program, entryClassName) {
    if (entryClassName !== 'TraceDojoJudge') throw new Error(`Unexpected entry class: ${entryClassName}`);
    const result = await compileJavaProgram(program);
    if (result.kind !== 'compileError') {
      throw new Error(`Expected a compiler rejection, received ${result.kind}: ${result.failure ?? result.stderr}`);
    }
    return { kind: 'compileError', message: result.stderr };
  },
};
