import { expect, test } from 'vitest';

import { independentJavaChallengeDefinitions } from '../../src/problems/challenge/javaDefinitions';
import { javaChallengeDefinitions } from '../../src/problems/javaChallenges/definitions';
import { javaChallengeMetadata } from '../../src/problems/javaChallenges/metadata';

test('committed fixed challenge metadata matches the catalog outside the independent bank', () => {
  expect(javaChallengeMetadata).toEqual(
    Object.fromEntries(
      Object.entries(javaChallengeDefinitions)
        .filter(([id]) => !independentJavaChallengeDefinitions[id])
        .map(([id, { title, courseId, lectureIndex, problemFormat }]) => [
          id,
          { title, courseId, lectureIndex, problemFormat },
        ])
    )
  );
});
