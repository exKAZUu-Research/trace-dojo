import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { javaChallengeDefinitions } from '../src/problems/javaChallenges/definitions';

const metadata = Object.fromEntries(
  Object.entries(javaChallengeDefinitions).map(([id, { title, courseId, lectureIndex, problemFormat }]) => [
    id,
    { title, courseId, lectureIndex, problemFormat },
  ])
);
const metadataPath = fileURLToPath(new URL('../src/problems/javaChallenges/metadata.ts', import.meta.url));
writeFileSync(
  metadataPath,
  `// Refresh with bun scripts/updateJavaChallengeMetadata.ts after editing the catalog.\nimport type { JavaChallengeDefinition } from './types';\n\nexport const javaChallengeMetadata = ${JSON.stringify(metadata, undefined, 2)} as const satisfies Record<string, Pick<JavaChallengeDefinition, 'title' | 'courseId' | 'lectureIndex' | 'problemFormat'>>;\n\nexport type JavaChallengeId = keyof typeof javaChallengeMetadata;\n`
);
execFileSync('bun', ['fmt', metadataPath], { stdio: 'inherit' });
