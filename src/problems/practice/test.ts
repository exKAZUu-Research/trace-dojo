import type { PracticeDefinition } from './types';

const define = (
  lecture: number,
  family: string,
  title: string,
  variant: number,
  java: string,
  instrumented: string,
  methods = ''
): PracticeDefinition => ({
  id: `practiceEasyV1TestL${lecture}${family}V${variant}`,
  lectureIndex: lecture - 1,
  title: `${title} ${variant}`,
  program: {
    java: `
public class Main {
    public static void main(String[] args) {
${java}
    }
${methods}}
`,
    instrumented,
  },
});

export const testPracticeDefinitions = [
  ...[1, 2, 3].map((variant) =>
    define(
      1,
      'HeadingOnly',
      '向きだけを変える',
      variant,
      `        Turtle t = new Turtle(${variant}, 2); // step
        t.左を向く(); // step`,
      `const t = new Turtle(${variant}, 2); registerDisplayRef('t', () => t); // step
t.turnLeft();`
    )
  ),
  ...[1, 2, 3].map((variant) =>
    define(
      1,
      'ScalarUpdate',
      '値を一度更新する',
      variant,
      `        Turtle t = new Turtle(${variant}, 2); // step
        int value = ${variant}; // step
        value--; // step`,
      `const t = new Turtle(${variant}, 2); registerDisplayRef('t', () => t); // step
s.set('value', ${variant});
s.set('value', s.get('value') - 1);`
    )
  ),
  ...[1, 2, 3].map((variant) =>
    define(
      1,
      'SingleAlias',
      '同じ亀を別の名前で動かす',
      variant,
      `        Turtle t = new Turtle(${variant}, 2); // step
        Turtle cursor = t; // step
        cursor.後に戻る(); // step`,
      `const t = new Turtle(${variant}, 2); registerDisplayRef('t', () => t); // step
const cursor = t; registerDisplayRef('cursor', () => cursor); // step
cursor.backward();`
    )
  ),
] satisfies PracticeDefinition[];
