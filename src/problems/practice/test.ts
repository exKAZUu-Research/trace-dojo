import type { PracticeDefinition } from './types';

const define = (
  lecture: number,
  family: string,
  title: string,
  variant: number,
  java: string,
  methods = ''
): PracticeDefinition => ({
  id: `practiceEasyV1TestL${lecture}${family}V${variant}`,
  lectureIndex: lecture - 1,
  title: `${title} ${variant}`,
  program: `
public class Main {
    public static void main(String[] args) {
${java}
    }
${methods}}
`,
});

export const testPracticeDefinitions = [
  ...[1, 2, 3].map((variant) =>
    define(
      1,
      'HeadingOnly',
      '向きだけを変える',
      variant,
      `        Turtle t = new Turtle(${variant}, 2);
        t.左を向く();`
    )
  ),
  ...[1, 2, 3].map((variant) =>
    define(
      1,
      'ScalarUpdate',
      '値を一度更新する',
      variant,
      `        Turtle t = new Turtle(${variant}, 2);
        int value = ${variant};
        value--;`
    )
  ),
  ...[1, 2, 3].map((variant) =>
    define(
      1,
      'SingleAlias',
      '同じ亀を別の名前で動かす',
      variant,
      `        Turtle t = new Turtle(${variant}, 2);
        Turtle cursor = t;
        cursor.後に戻る();`
    )
  ),
] satisfies PracticeDefinition[];
