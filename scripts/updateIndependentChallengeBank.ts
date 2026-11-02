import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { challengeBases } from '../src/problems/challenge/definitions';
import { independentJavaChallengeDefinitions } from '../src/problems/challenge/javaDefinitions';

const programs = Object.fromEntries(challengeBases.map(({ id, java, instrumented }) => [id, { java, instrumented }]));
const metadata = Object.fromEntries([
  ...challengeBases.map(({ id, title, courseId, lectureIndex }) => [
    id,
    { title, courseId, lectureIndex, problemFormat: 'regular' },
  ]),
  ...Object.entries(independentJavaChallengeDefinitions).map(
    ([id, { title, courseId, lectureIndex, problemFormat }]) => [id, { title, courseId, lectureIndex, problemFormat }]
  ),
]);
const programsPath = fileURLToPath(new URL('../src/problems/challenge/regularPrograms.ts', import.meta.url));
const metadataPath = fileURLToPath(new URL('../src/problems/challenge/metadata.ts', import.meta.url));
writeFileSync(
  programsPath,
  `export const challengeRegularPrograms: Record<string, { java: string; instrumented: string }> = ${JSON.stringify(programs, undefined, 2)};\n`
);
writeFileSync(
  metadataPath,
  `export interface ChallengeMetadata {\n  title: string;\n  courseId: 'tuBeginner1' | 'tuBeginner2';\n  lectureIndex: number;\n  problemFormat: 'regular' | 'fillInBlank' | 'bugFix';\n}\nexport const challengeMetadata = ${JSON.stringify(metadata, undefined, 2)} as const satisfies Record<string, ChallengeMetadata>;\n\nexport type ChallengeId = keyof typeof challengeMetadata;\n`
);
execFileSync('bun', ['fmt', programsPath, metadataPath], { stdio: 'inherit' });
