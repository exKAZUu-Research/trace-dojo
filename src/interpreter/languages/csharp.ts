import { executeCSharpProgram } from '../../csharp/execute';
import { findCSharpTraceAnnotations } from '../../csharp/parse';
import { traceCSharpProgram } from '../../csharp/trace';
import type { Interpreter } from '../interpreter';

export const interpreter: Interpreter = {
  findTraceAnnotations: findCSharpTraceAnnotations,
  record: traceCSharpProgram,
  execute: executeCSharpProgram,
};
