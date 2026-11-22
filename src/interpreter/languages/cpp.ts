import { executeCppProgram } from '../../cpp/execute';
import { findCppTraceAnnotations } from '../../cpp/parse';
import { traceCppProgram } from '../../cpp/trace';
import type { Interpreter } from '../interpreter';

export const interpreter: Interpreter = {
  findTraceAnnotations: findCppTraceAnnotations,
  record: traceCppProgram,
  execute: executeCppProgram,
};
