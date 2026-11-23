import type { InterpreterRunner } from '../interpreter/worker/interpreterRunner';

/** What traces model programs and executes learners' programs: the interpreter worker of a browser. */
export type ProblemRunner = Pick<InterpreterRunner, 'traceProgram' | 'executeProgram'>;
