import { findTypeScriptTraceAnnotations } from '../../typescript/parse';
import { executeTypeScriptProgram } from '../../typescript/run';
import { traceTypeScriptProgram } from '../../typescript/trace';
import type { Interpreter } from '../interpreter';

export const interpreter: Interpreter = {
  findTraceAnnotations: findTypeScriptTraceAnnotations,
  record: traceTypeScriptProgram,
  execute: executeTypeScriptProgram,
};
