'use client';

import { RegularExerciseBody } from '../RegularExerciseBody';
import type { RegularExerciseTransport } from '../RegularExerciseBody';

export type RegularChallengeTransport = RegularExerciseTransport;
export const RegularChallengeBody: React.FC<Omit<React.ComponentProps<typeof RegularExerciseBody>, 'mode'>> = (
  props
) => <RegularExerciseBody {...props} mode="challenge" />;
