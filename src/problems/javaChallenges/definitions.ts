import { independentJavaChallengeDefinitions } from '../challenge/javaDefinitions';
import { beginner1Early } from './beginner1Early';
import { beginner1Late } from './beginner1Late';
import { beginner2Early } from './beginner2Early';
import { beginner2Late } from './beginner2Late';
import { sourceBeginner2EarlyBlanks } from './sourceBeginner2EarlyBlanks';
import { sourceBeginner2EarlyBugs } from './sourceBeginner2EarlyBugs';
import { sourceBeginner2LateBlanks } from './sourceBeginner2LateBlanks';
import { sourceBeginner2LateBugs } from './sourceBeginner2LateBugs';
import { sourceI1To4Blanks } from './sourceI1To4Blanks';
import { sourceI1To4Bugs } from './sourceI1To4Bugs';
import { sourceI5To8Blanks } from './sourceI5To8Blanks';
import { sourceI5To8Bugs } from './sourceI5To8Bugs';
import { testProblems } from './testProblems';
import type { JavaChallengeDefinition } from './types';

export const javaChallengeDefinitions: Record<string, JavaChallengeDefinition> = {
  ...beginner1Early,
  ...beginner1Late,
  ...beginner2Early,
  ...beginner2Late,
  ...testProblems,
  ...independentJavaChallengeDefinitions,
  ...sourceI1To4Blanks,
  ...sourceI5To8Blanks,
  ...sourceBeginner2EarlyBlanks,
  ...sourceBeginner2LateBlanks,
  ...sourceI1To4Bugs,
  ...sourceI5To8Bugs,
  ...sourceBeginner2EarlyBugs,
  ...sourceBeginner2LateBugs,
};
