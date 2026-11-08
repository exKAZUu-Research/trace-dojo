import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { challengeBases } from '../src/problems/challenge/definitions';
import { independentJavaChallengeDefinitions } from '../src/problems/challenge/javaDefinitions';

const metadata = Object.fromEntries([
  ...challengeBases.map(({ id, title, courseId, lectureIndex }) => [
    id,
    { title, courseId, lectureIndex, problemFormat: 'regular' },
  ]),
  ...Object.entries(independentJavaChallengeDefinitions).map(
    ([id, { title, courseId, lectureIndex, problemFormat }]) => [id, { title, courseId, lectureIndex, problemFormat }]
  ),
]);
const metadataPath = fileURLToPath(new URL('../src/problems/challenge/metadata.ts', import.meta.url));
writeFileSync(
  metadataPath,
  `export interface ChallengeMetadata {\n  title: string;\n  courseId: 'tuBeginner1' | 'tuBeginner2';\n  lectureIndex: number;\n  problemFormat: 'regular' | 'fillInBlank' | 'bugFix';\n}\nexport const challengeMetadata = ${JSON.stringify(metadata, undefined, 2)} as const satisfies Record<string, ChallengeMetadata>;\n\nexport type ChallengeId = keyof typeof challengeMetadata;\n`
);
execFileSync('bun', ['fmt', metadataPath], { stdio: 'inherit' });
