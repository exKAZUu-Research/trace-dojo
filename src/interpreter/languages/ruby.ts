import { findRubyTraceAnnotations } from '../../ruby/parse';
import { executeRubyProgram } from '../../ruby/run';
import { traceRubyProgram } from '../../ruby/trace';
import type { Interpreter } from '../interpreter';

export const interpreter: Interpreter = {
  findTraceAnnotations: findRubyTraceAnnotations,
  record: traceRubyProgram,
  execute: executeRubyProgram,
};
