import { executeKotlinProgram } from '../../kotlin/execute';
import { findKotlinTraceAnnotations } from '../../kotlin/parse';
import { traceKotlinProgram } from '../../kotlin/trace';
import type { Interpreter } from '../interpreter';

export const interpreter: Interpreter = {
  findTraceAnnotations: findKotlinTraceAnnotations,
  record: traceKotlinProgram,
  execute: executeKotlinProgram,
};
