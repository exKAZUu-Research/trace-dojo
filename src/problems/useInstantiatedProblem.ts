'use client';

import { useEffect } from 'react';
import { useImmer } from 'use-immer';

import { getBrowserProblemRunner } from './browserProblemRunner';
import { type InstantiatedProblem, instantiateTemplate } from './instantiateTemplate';

export interface ProblemTemplate {
  programTemplate: string;
  seed: string;
}

export type ProblemInstantiation =
  /** No template was given. */
  | { status: 'absent' }
  | { status: 'loading' }
  | { status: 'ready'; problem: InstantiatedProblem }
  /** The interpreter could not be loaded or could not trace the program. */
  | { status: 'failed' };

/** Instantiates and traces a problem in the interpreter worker, again whenever the template or the seed changes. */
export function useInstantiatedProblem(template: ProblemTemplate | undefined): ProblemInstantiation {
  const programTemplate = template?.programTemplate;
  const seed = template?.seed;
  const key = JSON.stringify([programTemplate, seed]);
  const [settled, setSettled] = useImmer<{ key: string; problem?: InstantiatedProblem } | undefined>(undefined);
  useEffect(() => {
    if (programTemplate === undefined || seed === undefined) return;
    let cancelled = false;
    void instantiateTemplate(getBrowserProblemRunner(), programTemplate, seed).then(
      (problem) => {
        if (!cancelled) setSettled({ key, problem });
      },
      (error: unknown) => {
        console.error(error);
        if (!cancelled) setSettled({ key });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [key, programTemplate, seed, setSettled]);

  if (!template) return { status: 'absent' };
  if (settled?.key !== key) return { status: 'loading' };
  return settled.problem ? { status: 'ready', problem: settled.problem } : { status: 'failed' };
}
