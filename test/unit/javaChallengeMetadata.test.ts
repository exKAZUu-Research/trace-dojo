import { expect, test } from 'vitest';

import { javaChallengeDefinitions } from '../../src/problems/javaChallenges/definitions';
import { javaChallengeMetadata } from '../../src/problems/javaChallenges/metadata';

test('committed challenge metadata matches the catalog', () => {
  expect(javaChallengeMetadata).toEqual(
    Object.fromEntries(
      Object.entries(javaChallengeDefinitions).map(([id, { title, courseId, lectureIndex, problemFormat }]) => [
        id,
        { title, courseId, lectureIndex, problemFormat },
      ])
    )
  );
});
