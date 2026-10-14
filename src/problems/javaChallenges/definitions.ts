import { beginner1Early } from './beginner1Early';
import { beginner1Late } from './beginner1Late';
import { beginner2Early } from './beginner2Early';
import { beginner2Late } from './beginner2Late';
import { testProblems } from './testProblems';
import type { JavaChallengeDefinition } from './types';

export const javaChallengeDefinitions: Record<string, JavaChallengeDefinition> = {
  ...beginner1Early,
  ...beginner1Late,
  ...beginner2Early,
  ...beginner2Late,
  ...testProblems,
};
