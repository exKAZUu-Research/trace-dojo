import { executeGoProgram } from '../../go/execute';
import { findGoTraceAnnotations } from '../../go/parse';
import { traceGoProgram } from '../../go/trace';
import type { Interpreter } from '../interpreter';

export const interpreter: Interpreter = {
  findTraceAnnotations: findGoTraceAnnotations,
  record: traceGoProgram,
  execute: executeGoProgram,
};
