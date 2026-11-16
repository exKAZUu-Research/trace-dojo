import type { ProgramRecording } from '../interpreter/program';
import type { ProgramInput } from '../interpreter/programIo';
import type { TraceOptions } from '../interpreter/traceAnnotations';
import { recordProgram } from '../javascript/trace';
import { parseTypeScript } from './parse';

// Classes in TypeScript declare static fields with their types, which learners follow as Java's.
export function traceTypeScriptProgram(program: string, trace: TraceOptions, input?: ProgramInput): ProgramRecording {
  return recordProgram(parseTypeScript(program, trace), input, true);
}
