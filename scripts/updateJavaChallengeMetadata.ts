import { writeFileSync } from 'node:fs';

import { javaChallengeDefinitions } from '../src/problems/javaChallenges/definitions';

const metadata = Object.fromEntries(
  Object.entries(javaChallengeDefinitions).map(([id, { title, courseId, lectureIndex, problemFormat }]) => [
    id,
    { title, courseId, lectureIndex, problemFormat },
  ])
);
writeFileSync(
  new URL('../src/problems/javaChallenges/metadata.ts', import.meta.url),
  `// Refresh with bun scripts/updateJavaChallengeMetadata.ts after editing the catalog.\nimport type { JavaChallengeDefinition } from './types';\n\nexport const javaChallengeMetadata: Record<string, Pick<JavaChallengeDefinition, 'title' | 'courseId' | 'lectureIndex' | 'problemFormat'>> = ${JSON.stringify(metadata, undefined, 2)};\n`
);
