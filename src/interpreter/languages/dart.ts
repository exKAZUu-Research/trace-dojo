import { executeDartProgram } from '../../dart/execute';
import { findDartTraceAnnotations } from '../../dart/parse';
import { traceDartProgram } from '../../dart/trace';
import type { Interpreter } from '../interpreter';

export const interpreter: Interpreter = {
  findTraceAnnotations: findDartTraceAnnotations,
  record: traceDartProgram,
  execute: executeDartProgram,
};
