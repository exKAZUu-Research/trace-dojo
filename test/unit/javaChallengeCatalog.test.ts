import { expect, test } from 'vitest';

import { challengeBases } from '../../src/problems/catalog/java/definitions';
import { instantiateGeneratedChallenge } from '../../src/problems/generation/instantiate';
import { gradeFillInBlankCode } from '../../src/problems/grading/turtleState';

const independentCases = [
  {
    name: 'movement and clockwise turn',
    body: 'Turtle t = new Turtle(); t.forward(); t.turnRight(); t.forward();',
    board: '#......\n##.....\n.......\n.......\n.......\n.......\n.......',
    turtles: [{ x: 1, y: 1, color: '#', dir: 'E' }],
  },
  {
    name: 'bounded for loop',
    body: 'Turtle t = new Turtle(); for (int i = 0; i < 3; i++) t.forward();',
    board: '#......\n#......\n#......\n#......\n.......\n.......\n.......',
    turtles: [{ x: 0, y: 3, color: '#', dir: 'N' }],
  },
  {
    name: 'branch selects backward movement',
    body: 'Turtle t = new Turtle(2, 2); int n = 2; if (n > 3) t.forward(); else t.backward();',
    board: '.......\n..#....\n..#....\n.......\n.......\n.......\n.......',
    turtles: [{ x: 2, y: 1, color: '#', dir: 'N' }],
  },
  {
    name: 'independent objects and reference alias',
    body: 'Turtle a = new Turtle(); Turtle b = new Turtle(2, 0, "R"); Turtle alias = a; alias.forward(); b.turnRight(); b.forward();',
    board: '#.RR...\n#......\n.......\n.......\n.......\n.......\n.......',
    turtles: [
      { x: 0, y: 1, color: '#', dir: 'N' },
      { x: 3, y: 0, color: 'R', dir: 'E' },
    ],
  },
  {
    name: 'custom class constructor and instance method',
    body: 'Walker w = new Walker(); w.walk();',
    classes: 'class Walker { Turtle t = new Turtle(1, 1); void walk() { t.forward(); t.turnRight(); } }',
    board: '.......\n.#.....\n.#.....\n.......\n.......\n.......\n.......',
    turtles: [{ x: 1, y: 2, color: '#', dir: 'E' }],
  },
];

test.each(independentCases)('grading agrees with hand-derived state: $name', ({ body, classes, board, turtles }) => {
  const source = `class Main { public static void main(String[] args) { ${body} } } ${classes ?? ''}`;
  expect(gradeFillInBlankCode({ finalBoard: board, finalTurtles: turtles }, source)).toEqual({ status: 'correct' });
});

test.each(['fillInBlank', 'bugFix'] as const)('every independent source generates playable %s exercises', (format) => {
  for (const base of challengeBases) {
    const result = instantiateGeneratedChallenge(base.id, 'catalog-coverage', format, base.courseId, base.lectureIndex);
    expect(result, base.id).toBeDefined();
    if (!result) continue;
    expect(gradeFillInBlankCode(result, result.correctProgram), base.id).toEqual({ status: 'correct' });
    expect(gradeFillInBlankCode(result, result.displayProgram).status, base.id).toBe('incorrect');
  }
});
