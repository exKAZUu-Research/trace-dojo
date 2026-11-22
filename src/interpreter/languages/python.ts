import { findPythonTraceAnnotations } from '../../python/parse';
import { executePythonProgram } from '../../python/run';
import { tracePythonProgram } from '../../python/trace';
import type { Interpreter } from '../interpreter';

export const interpreter: Interpreter = {
  findTraceAnnotations: findPythonTraceAnnotations,
  record: tracePythonProgram,
  execute: executePythonProgram,
};
