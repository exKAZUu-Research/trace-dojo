import { executeJavaProgram } from '../../java/execute';
import { traceJavaProgram } from '../../java/trace';
import { findJavaTraceAnnotations } from '../../problems/fillInBlank/javaSource';
import type { Interpreter } from '../interpreter';

export const interpreter: Interpreter = {
  findTraceAnnotations: findJavaTraceAnnotations,
  record: traceJavaProgram,
  execute: executeJavaProgram,
};
