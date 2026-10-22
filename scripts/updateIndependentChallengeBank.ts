import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { challengeBases } from '../src/problems/challenge/definitions';
import { traceProgram } from '../src/problems/traceProgram';
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

const manifest = challengeBases.map((base) => {
  const trace = traceProgram(base.instrumented, base.java, 'java');
  return {
    id: base.id,
    file: `src/problems/challenge/${base.courseId}/lecture${base.lectureIndex + 1}.ts`,
    title: base.title,
    courseId: base.courseId,
    lectureIndex: base.lectureIndex,
    steps: trace.traceItems.length - 1,
    blankIds: base.blanks.map((edit) => `${base.id}Blank${edit.id}`),
    bugIds: base.bugs.map((edit) => `${base.id}Bug${edit.id}`),
    finalBoard: trace.finalBoard,
    finalTurtles: trace.finalTurtles,
    sha256: createHash('sha256').update(JSON.stringify(base)).digest('hex'),
  };
});
writeFileSync(
  new URL('../src/problems/challenge/manifest.json', import.meta.url),
  `${JSON.stringify(manifest, undefined, 2)}\n`
);
