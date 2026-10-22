import type { ChallengeEdit } from './types';

export function applyChallengeEdit(program: string, edit: ChallengeEdit): string {
  const index = program.indexOf(edit.before);
  if (!edit.before || index === -1 || program.includes(edit.before, index + edit.before.length))
    throw new Error(`Challenge edit must match once: ${edit.id}`);
  return program.slice(0, index) + edit.after + program.slice(index + edit.before.length);
}
