import type { JavaProblemPresentation } from '../../src/problems/fillInBlank/exerciseProblem';
import { type FillInBlankVerdict, gradeFillInBlankCode } from '../../src/problems/fillInBlank/grade';
import type { InstantiatedProblem } from '../../src/problems/instantiateTemplate';
import { instantiateTemplate } from '../../src/problems/instantiateTemplate';
import { javaChallengeDefinitions } from '../../src/problems/javaChallenges/definitions';
import { instantiateJavaChallenge } from '../../src/problems/javaChallenges/instantiate';
import { instantiateProblem, nodeRunner } from './nodeProblems';

type Input = Record<string, unknown>;
type Invoke = (procedure: string, input: object) => Promise<unknown>;

/** A stored session, from which a page regenerates its problem. */
export interface StoredProblem {
  problemId: string;
  seed: string;
}

/**
 * Calls procedures as the pages do, which run the interpreter around the server: `startExercise` and `nextExercise`
 * return a Java problem generated from its template (saying that the page traces regular ones itself), `submitExercise` and `createFillInBlankSubmission` grade the code
 * and resolve to the verdict they report unless the input states one, and `submitRegularExercise` tells whether the
 * step is the last one unless the input does.
 */
export function withBrowserSide(
  invoke: Invoke,
  findProblem: (procedure: string, sessionId: number) => StoredProblem | undefined
): Invoke {
  const grade = async (procedure: string, input: Input): Promise<FillInBlankVerdict> => {
    const stored = findProblem(procedure, input.sessionId as number);
    const problem = stored && (await presentJavaProblem(stored).catch(() => {}));
    // No page shows a session whose problem does not exist, so a request for one reports an arbitrary verdict.
    if (!problem) return { status: 'incorrect', detail: 'No such problem.' };
    return await gradeFillInBlankCode(nodeRunner, problem, input.code as string);
  };
  return async (procedure, request) => {
    const input = request as Input;
    switch (procedure) {
      case 'startExercise':
      case 'nextExercise': {
        const request = input.problemFormat === 'regular' ? { tracesInBrowser: true, ...input } : input;
        return await showProblem(await invoke(procedure, request));
      }
      case 'submitExercise': {
        if ('status' in input) return await invoke(procedure, input);
        const verdict = await grade(procedure, input);
        await invoke(procedure, { ...input, status: verdict.status });
        return verdict;
      }
      case 'createFillInBlankSubmission': {
        if ('isCorrect' in input) return await invoke(procedure, input);
        const verdict = await grade(procedure, input);
        await invoke(procedure, { ...input, isCorrect: verdict.status === 'correct' });
        return verdict;
      }
      case 'submitRegularExercise': {
        if ('isLastStep' in input) return await invoke(procedure, input);
        const stored = findProblem(procedure, input.sessionId as number);
        const { traceItemIndex } = input.context as { traceItemIndex: number };
        const problem = stored && (await instantiateProblem(stored.problemId, stored.seed).catch(() => {}));
        return await invoke(procedure, {
          ...input,
          isLastStep: problem !== undefined && traceItemIndex >= problem.traceItems.length - 1,
        });
      }
      default: {
        return await invoke(procedure, input);
      }
    }
  };
}

async function showProblem(display: unknown): Promise<unknown> {
  if (typeof display !== 'object' || display === null || !('programTemplate' in display)) return display;
  const { programTemplate, seed, ...rest } = display as {
    programTemplate: string;
    seed: string;
    problemFormat: string;
  };
  // A regular exercise keeps its template, since its page shows the trace rather than a state to reach.
  if (rest.problemFormat === 'regular') return display;
  return { ...rest, ...toPresentation(await instantiateTemplate(nodeRunner, programTemplate, seed)) };
}

async function presentJavaProblem({ problemId, seed }: StoredProblem): Promise<JavaProblemPresentation> {
  const definition = javaChallengeDefinitions[problemId];
  return definition
    ? instantiateJavaChallenge(problemId, definition.problemFormat)
    : toPresentation(await instantiateProblem(problemId, seed));
}

function toPresentation({ displayProgram, finalBoard, finalTurtles }: InstantiatedProblem): JavaProblemPresentation {
  return { displayProgram, finalBoard, finalTurtles };
}
