import { findJavaScriptTraceAnnotations } from '../../javascript/parse';
import { executeJavaScriptProgram } from '../../javascript/run';
import { traceJavaScriptProgram } from '../../javascript/trace';
import type { Interpreter } from '../interpreter';

export const interpreter: Interpreter = {
  findTraceAnnotations: findJavaScriptTraceAnnotations,
  record: traceJavaScriptProgram,
  execute: executeJavaScriptProgram,
};
