import { findPhpTraceAnnotations } from '../../php/parse';
import { executePhpProgram } from '../../php/run';
import { tracePhpProgram } from '../../php/trace';
import type { Interpreter } from '../interpreter';

export const interpreter: Interpreter = {
  findTraceAnnotations: findPhpTraceAnnotations,
  record: tracePhpProgram,
  execute: executePhpProgram,
};
