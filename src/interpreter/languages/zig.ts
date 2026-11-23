import { executeZigProgram } from '../../zig/execute';
import { findZigTraceAnnotations } from '../../zig/parse';
import { traceZigProgram } from '../../zig/trace';
import type { Interpreter } from '../interpreter';

export const interpreter: Interpreter = {
  findTraceAnnotations: findZigTraceAnnotations,
  record: traceZigProgram,
  execute: executeZigProgram,
};
