import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { traceProgram } from '../src/interpreter/program';
import {
  buildIndependentJavaChallengeDefinitions,
  type ChallengeTarget,
  parsedChallengeBases,
} from '../src/problems/challenge/buildJavaDefinitions';

const directionSchema = z.enum(['N', 'E', 'S', 'W']);

const targets: Record<string, ChallengeTarget> = {};
for (const base of parsedChallengeBases) {
  let trace: ReturnType<typeof traceProgram>;
  try {
    trace = traceProgram('java', base.java, base.java);
  } catch (error) {
    throw new Error(`Invalid challenge trace: ${base.id}`, { cause: error });
  }
  targets[base.id] = {
    finalBoard: trace.finalBoard,
    finalTurtles: trace.finalTurtles.map(({ x, y, color, dir }) => ({ x, y, color, dir: directionSchema.parse(dir) })),
  };
}
const targetsPath = fileURLToPath(new URL('../src/problems/challenge/targets.ts', import.meta.url));
writeFileSync(
  targetsPath,
  `// Refresh with bun scripts/updateIndependentChallengeBank.ts after editing the bank.\nimport type { ChallengeTarget } from './buildJavaDefinitions';\n\nexport const challengeTargets: Record<string, ChallengeTarget> = ${JSON.stringify(targets, undefined, 2)};\n`
);

const metadata = Object.fromEntries([
  ...parsedChallengeBases.map(({ id, title, courseId, lectureIndex }) => [
    id,
    { title, courseId, lectureIndex, problemFormat: 'regular' },
  ]),
  ...Object.entries(buildIndependentJavaChallengeDefinitions(targets)).map(
    ([id, { title, courseId, lectureIndex, problemFormat }]) => [id, { title, courseId, lectureIndex, problemFormat }]
  ),
]);
const metadataPath = fileURLToPath(new URL('../src/problems/challenge/metadata.ts', import.meta.url));
writeFileSync(
  metadataPath,
  `export interface ChallengeMetadata {\n  title: string;\n  courseId: 'tuBeginner1' | 'tuBeginner2';\n  lectureIndex: number;\n  problemFormat: 'regular' | 'fillInBlank' | 'bugFix';\n}\nexport const challengeMetadata = ${JSON.stringify(metadata, undefined, 2)} as const satisfies Record<string, ChallengeMetadata>;\n\nexport type ChallengeId = keyof typeof challengeMetadata;\n`
);
execFileSync('bun', ['fmt', targetsPath, metadataPath], { stdio: 'inherit' });
