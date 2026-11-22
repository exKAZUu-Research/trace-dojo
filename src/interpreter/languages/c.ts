import { executeCProgram } from '../../c/execute';
import { findCTraceAnnotations } from '../../c/parse';
import { traceCProgram } from '../../c/trace';
import type { Interpreter } from '../interpreter';

export const interpreter: Interpreter = {
  findTraceAnnotations: findCTraceAnnotations,
  record: traceCProgram,
  execute: executeCProgram,
};
