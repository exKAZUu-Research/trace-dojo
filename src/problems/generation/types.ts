import type { TurtleTrace } from '../trace';

export type Selector =
  | 'for'
  | 'while'
  | 'if'
  | 'switch'
  | 'operator'
  | 'literal'
  | 'variableReference'
  | 'variableDeclaration'
  | 'assignment'
  | 'call'
  | 'construction'
  | 'member'
  | 'array'
  | 'return'
  | 'throw'
  | 'break'
  | 'continue'
  | 'modifier';
export type ChallengeFormat = 'fillInBlank' | 'bugFix';
export type BugKind = 'logical' | 'syntax';
export interface ChallengeTarget {
  finalBoard: string;
  finalTurtles: TurtleTrace[];
}

/** Half-open UTF-16 offsets into canonical source. Identical text at different offsets is a different candidate. */
export interface Candidate {
  start: number;
  end: number;
  replacements: string[];
}
export interface GenerationInput {
  source: string;
  selectors: readonly Selector[];
  format: ChallengeFormat;
  seed: string;
  bugKind?: BugKind;
}
export interface GeneratedExercise<T> {
  correctProgram: string;
  displayProgram: string;
  answer?: string;
  range: { start: number; end: number };
  bugKind?: BugKind;
  target: T;
}
export type Evaluation<T> = { kind: 'success'; target: T } | { kind: 'compileError' | 'invalid' | 'timeout' };

/** Adapters own syntax and execution. Shared generation never receives parser nodes or language-specific types. */
export interface GenerationAdapter<T> {
  canonicalize: (source: string) => string;
  collect: (source: string, selectors: readonly Selector[]) => Candidate[];
  evaluate: (source: string) => Evaluation<T>;
  equals: (left: T, right: T) => boolean;
}
