import { executeProgram } from '../../../../interpreter/program';
import { isSameTurtleState } from '../../../fillInBlank/javaProgram';
import { stripJavaTraceAnnotations } from '../../../fillInBlank/javaSource';
import { generateExercise } from '../../generate';
import type { ChallengeTarget, Evaluation, GeneratedExercise, GenerationInput } from '../../types';
import { collectJavaCandidates } from './collectCandidates';

export function generateJavaExercise(
  input: GenerationInput
): (GeneratedExercise<ChallengeTarget> & ChallengeTarget) | undefined {
  const result = generateExercise(input, {
    canonicalize: stripJavaTraceAnnotations,
    collect: collectJavaCandidates,
    evaluate,
    equals: (a, b) =>
      isSameTurtleState(
        { board: a.finalBoard, turtles: a.finalTurtles },
        { board: b.finalBoard, turtles: b.finalTurtles }
      ),
  });
  if (!result) return;
  return { ...result, ...result.target };
}

function evaluate(source: string): Evaluation<ChallengeTarget> {
  const result = executeProgram('java', source);
  if (result.kind === 'compileError') return { kind: 'compileError' };
  if (result.kind === 'limitExceeded') return { kind: result.limit === 'time' ? 'timeout' : 'invalid' };
  if (result.uncaughtException) return { kind: 'invalid' };
  return { kind: 'success', target: { finalBoard: result.finalBoard, finalTurtles: result.finalTurtles } };
}
