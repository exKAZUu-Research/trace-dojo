import { findBashTraceAnnotations } from '../../bash/parse';
import { executeBashProgram } from '../../bash/run';
import { traceBashProgram } from '../../bash/trace';
import type { Interpreter } from '../interpreter';

export const interpreter: Interpreter = {
  findTraceAnnotations: findBashTraceAnnotations,
  record: traceBashProgram,
  execute: executeBashProgram,
};
