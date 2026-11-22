import { findHaskellTraceAnnotations } from '../../haskell/parse';
import { executeHaskellProgram } from '../../haskell/run';
import { traceHaskellProgram } from '../../haskell/trace';
import type { Interpreter } from '../interpreter';

export const interpreter: Interpreter = {
  findTraceAnnotations: findHaskellTraceAnnotations,
  record: traceHaskellProgram,
  execute: executeHaskellProgram,
};
