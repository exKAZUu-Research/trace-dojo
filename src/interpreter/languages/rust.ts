import { executeRustProgram } from '../../rust/execute';
import { findRustTraceAnnotations } from '../../rust/parse';
import { traceRustProgram } from '../../rust/trace';
import type { Interpreter } from '../interpreter';

export const interpreter: Interpreter = {
  findTraceAnnotations: findRustTraceAnnotations,
  record: traceRustProgram,
  execute: executeRustProgram,
};
