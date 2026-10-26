import { writeFileSync } from 'node:fs';
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
writeFileSync(
  new URL('../src/problems/challenge/regularPrograms.ts', import.meta.url),
  `export const challengeRegularPrograms: Record<string, { java: string; instrumented: string }> = ${JSON.stringify(programs, undefined, 2)};\n`
);
writeFileSync(
  new URL('../src/problems/challenge/metadata.ts', import.meta.url),
  `export interface ChallengeMetadata {\n  title: string;\n  courseId: 'tuBeginner1' | 'tuBeginner2';\n  lectureIndex: number;\n  problemFormat: 'regular' | 'fillInBlank' | 'bugFix';\n}\nexport const challengeMetadata: Record<string, ChallengeMetadata> = ${JSON.stringify(metadata, undefined, 2)};\n`
);
