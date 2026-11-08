import type { Selector } from '../generation/types';

const basics: Selector[] = ['call', 'construction', 'literal', 'variableReference'];
const variables: Selector[] = [
  ...basics,
  'variableDeclaration',
  'assignment',
  'arithmeticOperator',
  'assignmentOperator',
  'updateOperator',
];
const loops: Selector[] = [...variables, 'for', 'while', 'comparisonOperator'];
const branches: Selector[] = [...loops, 'if'];
const selection: Selector[] = [...branches, 'switch'];
const jumps: Selector[] = [...selection, 'break', 'continue', 'logicalOperator'];
const methods: Selector[] = [...jumps, 'return'];
const arrays: Selector[] = [...methods, 'array'];
const objects: Selector[] = [...arrays, 'member'];
const modifiers: Selector[] = [...objects, 'modifier'];
const exceptions: Selector[] = [...modifiers, 'throw'];

/** Policies select candidate owners, not ancestor gates. Header owners do not grant operator knowledge: operator families are explicit prerequisites for mutations even inside whole headers. */
export const generationPolicies: Record<string, readonly Selector[][]> = {
  tuBeginner1: [basics, variables, loops, branches, selection, jumps, methods, arrays],
  tuBeginner2: [arrays, objects, modifiers, modifiers, modifiers, modifiers, exceptions, exceptions],
  test: [exceptions, exceptions],
};

export function selectorsFor(courseId: string, lectureIndex: number): readonly Selector[] {
  return generationPolicies[courseId]?.[lectureIndex] ?? [];
}
