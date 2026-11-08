import type { PracticeDefinition } from './types';

const define = (
  lecture: number,
  family: string,
  title: string,
  variant: number,
  java: string,
  methods = ''
): PracticeDefinition => ({
  id: `practiceEasyV1Beginner1L${lecture}${family}V${variant}`,
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

export const beginner1PracticeDefinitions = [
  define(
    1,
    'TerminalTurn',
    '進んで向きを変える',
    1,
    `        Turtle t = new Turtle();
        t.前に進む();
        t.右を向く();`
  ),
  define(
    1,
    'TerminalTurn',
    '進んで向きを変える',
    2,
    `        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.右を向く();`
  ),
  define(
    1,
    'TerminalTurn',
    '進んで向きを変える',
    3,
    `        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.前に進む();
        t.右を向く();`
  ),
  define(
    1,
    'FinishBackward',
    '向きを変えて一歩戻る',
    1,
    `        Turtle t = new Turtle();
        t.前に進む();
        t.左を向く();
        t.後に戻る();`
  ),
  define(
    1,
    'FinishBackward',
    '向きを変えて一歩戻る',
    2,
    `        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.左を向く();
        t.後に戻る();`
  ),
  define(
    1,
    'FinishBackward',
    '向きを変えて一歩戻る',
    3,
    `        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.前に進む();
        t.左を向く();
        t.後に戻る();`
  ),
  define(
    1,
    'OppositeBackward',
    '反対を向いて戻る',
    1,
    `        Turtle t = new Turtle();
        t.右を向く();
        t.右を向く();
        t.後に戻る();`
  ),
  define(
    1,
    'OppositeBackward',
    '反対を向いて戻る',
    2,
    `        Turtle t = new Turtle();
        t.右を向く();
        t.右を向く();
        t.後に戻る();
        t.後に戻る();`
  ),
  define(
    1,
    'OppositeBackward',
    '反対を向いて戻る',
    3,
    `        Turtle t = new Turtle();
        t.右を向く();
        t.右を向く();
        t.後に戻る();
        t.後に戻る();
        t.後に戻る();`
  ),
  ...[1, 2, 3].map((variant) =>
    define(
      2,
      'CoordinateRead',
      '座標の値を読む',
      variant,
      `        int value = ${variant};
        Turtle t = new Turtle(value, 1);
        t.右を向く();`
    )
  ),
  ...[1, 2, 3].map((variant) =>
    define(
      2,
      'UpdateAfterCreation',
      '値を一度増やす',
      variant,
      `        int value = ${variant};
        Turtle t = new Turtle(value, 1);
        value++;`
    )
  ),
  ...[1, 2, 3].map((variant) =>
    define(
      2,
      'ReadExpression',
      '値から計算する',
      variant,
      `        Turtle t = new Turtle(${variant}, 1);
        int value = ${variant};
        int next = value + 1;`
    )
  ),
  ...[1, 2, 3].map((variant) =>
    define(
      3,
      'Countdown',
      '残りの回数を減らす',
      variant,
      `        Turtle t = new Turtle(1, 1);
        int remaining = ${variant};
        while (remaining > 0) {
            t.前に進む();
            remaining--;
        }`
    )
  ),
  ...[1, 2, 3].map((variant) =>
    define(
      3,
      'RepeatedTurn',
      '同じ向きに回る',
      variant,
      `        Turtle t = new Turtle(1, 1);
        for (int i = 0; i < ${variant}; i++) {
            t.右を向く();
        }`
    )
  ),
  ...[1, 2, 3].map((variant) =>
    define(
      3,
      'RepeatedIncrement',
      '値を一ずつ増やす',
      variant,
      `        Turtle t = new Turtle(1, 1);
        int value = 0;
        for (int i = 0; i < ${variant}; i++) {
            value++;
        }`
    )
  ),
  ...[1, 2, 3].map((variant) =>
    define(
      4,
      'SingleChoice',
      '条件で向きを変える',
      variant,
      `        Turtle t = new Turtle(1, 1);
        int value = ${variant};
        if (value > 1) {
            t.右を向く();
        }
        t.前に進む();`
    )
  ),
  ...[1, 2, 3].map((variant) =>
    define(
      4,
      'UpdatedChoice',
      '更新後の値で選ぶ',
      variant,
      `        Turtle t = new Turtle(1, 1);
        int value = ${variant};
        value--;
        if (value == 2) {
            t.右を向く();
        }
        t.前に進む();`
    )
  ),
  ...[1, 2, 3].map((variant) =>
    define(
      4,
      'NestedTurns',
      '二重の繰り返し',
      variant,
      `        Turtle t = new Turtle(1, 1);
        for (int row = 0; row < ${['1', '2', '2'][variant - 1]}; row++) {
            for (int column = 0; column < ${['2', '1', '2'][variant - 1]}; column++) {
                t.右を向く();
            }
        }`
    )
  ),
  ...[1, 2, 3].map((variant) =>
    define(
      5,
      'EitherDirection',
      '二つの向きから選ぶ',
      variant,
      `        Turtle t = new Turtle(2, 2);
        int value = ${variant};
        if (value > 1) {
            t.右を向く();
        } else {
            t.左を向く();
        }`
    )
  ),
  ...[1, 2, 3].map((variant) =>
    define(
      5,
      'ThreeChoices',
      '三つの動作から選ぶ',
      variant,
      `        Turtle t = new Turtle(2, 2);
        int value = ${variant};
        if (value == 1) {
            t.前に進む();
        } else if (value == 2) {
            t.右を向く();
        } else {
            t.後に戻る();
        }`
    )
  ),
  ...[1, 2, 3].map((variant) =>
    define(
      5,
      'SingleSwitch',
      '番号で動作を選ぶ',
      variant,
      `        Turtle t = new Turtle(2, 2);
        int value = ${variant};
        switch (value) {
            case 1:
                t.左を向く();
                break;
            case 2:
                t.後に戻る();
                break;
            default:
                t.右を向く();
                break;
        }`
    )
  ),
  ...[1, 2, 3].map((variant) =>
    define(
      6,
      'StopBeforeTurn',
      '途中で繰り返しを終える',
      variant,
      `        Turtle t = new Turtle(2, 2);
        for (int i = 1; i <= 3; i++) {
            if (i == ${variant}) {
                break;
            }
            t.右を向く();
        }`
    )
  ),
  ...[1, 2, 3].map((variant) =>
    define(
      6,
      'SkipTurn',
      '残りの動作を飛ばす',
      variant,
      `        Turtle t = new Turtle(2, 2);
        for (int i = 1; i <= ${variant}; i++) {
            t.前に進む();
            if (i == 1) {
                continue;
            }
            t.右を向く();
        }`
    )
  ),
  ...[1, 2, 3].map((variant) =>
    define(
      6,
      'ContinueUpdate',
      '飛ばした後も回数を増やす',
      variant,
      `        Turtle t = new Turtle(2, 2);
        int i = 0;
        for (; i < ${variant}; i++) {
            if (i < 1) {
                continue;
            }
            t.右を向く();
        }`
    )
  ),
  ...[1, 2, 3].map((variant) =>
    define(
      7,
      'LocalHelper',
      '引数なしで呼び出す',
      variant,
      `        place();`,
      `    static void place() {
        Turtle t = new Turtle(${variant}, 1);
        t.右を向く();
    }
`
    )
  ),
  ...[1, 2, 3].map((variant) =>
    define(
      7,
      'CoordinateParameter',
      '一つの値を渡す',
      variant,
      `        place(${variant});`,
      `    static void place(int x) {
        Turtle t = new Turtle(x, 1);
        t.左を向く();
    }
`
    )
  ),
  ...[1, 2, 3].map((variant) =>
    define(
      7,
      'SimpleReturn',
      '戻り値を受け取る',
      variant,
      `        Turtle t = new Turtle(2, 2);
        int result = next(${variant});`,
      `    static int next(int value) {
        return value + 1;
    }
`
    )
  ),
  ...[1, 2, 3].map((variant) =>
    define(
      8,
      'ReadCell',
      '配列の一つを読む',
      variant,
      `        Turtle t = new Turtle(2, 2);
        int[] values = {1, 2, 3};
        int selected = values[${variant - 1}];`
    )
  ),
  ...[1, 2, 3].map((variant) =>
    define(
      8,
      'ReplaceCell',
      '配列の一つを置き換える',
      variant,
      `        Turtle t = new Turtle(2, 2);
        int[] values = {0, 0, 0};
        values[1] = ${variant};
        int selected = values[1];`
    )
  ),
  ...[1, 2, 3].map((variant) =>
    define(
      8,
      'StringLength',
      '文字列の長さを読む',
      variant,
      `        Turtle t = new Turtle(2, 2);
        String word = ${['"a"', '"ab"', '"abc"'][variant - 1]};
        int length = word.length();`
    )
  ),
] satisfies PracticeDefinition[];
