import type { ProgramExecution } from '../interpreter/program';
import type { ProgramInput } from '../interpreter/programIo';
import { executeParsedProgram } from '../javascript/run';
import { parseTypeScript } from './parse';

/** Type-checks and runs a learner's program, as `tsc --strict` and then Node.js would. */
export function executeTypeScriptProgram(source: string, input?: ProgramInput): ProgramExecution {
  return executeParsedProgram(() => parseTypeScript(source), input);
}
