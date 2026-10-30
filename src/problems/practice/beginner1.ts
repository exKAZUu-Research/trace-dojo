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
  id: `practiceEasyV1Beginner1L${lecture}${family}V${variant}`,
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

export const beginner1PracticeDefinitions = [
  define(
    1,
    'TerminalTurn',
    '進んで向きを変える',
    1,
    `        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.右を向く(); // step`,
    `const t = new Turtle(); registerDisplayRef('t', () => t); // step
t.forward();
t.turnRight();`
  ),
  define(
    1,
    'TerminalTurn',
    '進んで向きを変える',
    2,
    `        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step`,
    `const t = new Turtle(); registerDisplayRef('t', () => t); // step
t.forward();
t.forward();
t.turnRight();`
  ),
  define(
    1,
    'TerminalTurn',
    '進んで向きを変える',
    3,
    `        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step`,
    `const t = new Turtle(); registerDisplayRef('t', () => t); // step
t.forward();
t.forward();
t.forward();
t.turnRight();`
  ),
  define(
    1,
    'FinishBackward',
    '向きを変えて一歩戻る',
    1,
    `        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.後に戻る(); // step`,
    `const t = new Turtle(); registerDisplayRef('t', () => t); // step
t.forward();
t.turnLeft();
t.backward();`
  ),
  define(
    1,
    'FinishBackward',
    '向きを変えて一歩戻る',
    2,
    `        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.後に戻る(); // step`,
    `const t = new Turtle(); registerDisplayRef('t', () => t); // step
t.forward();
t.forward();
t.turnLeft();
t.backward();`
  ),
  define(
    1,
    'FinishBackward',
    '向きを変えて一歩戻る',
    3,
    `        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.後に戻る(); // step`,
    `const t = new Turtle(); registerDisplayRef('t', () => t); // step
t.forward();
t.forward();
t.forward();
t.turnLeft();
t.backward();`
  ),
  define(
    1,
    'OppositeBackward',
    '反対を向いて戻る',
    1,
    `        Turtle t = new Turtle(); // step
        t.右を向く(); // step
        t.右を向く(); // step
        t.後に戻る(); // step`,
    `const t = new Turtle(); registerDisplayRef('t', () => t); // step
t.turnRight();
t.turnRight();
t.backward();`
  ),
  define(
    1,
    'OppositeBackward',
    '反対を向いて戻る',
    2,
    `        Turtle t = new Turtle(); // step
        t.右を向く(); // step
        t.右を向く(); // step
        t.後に戻る(); // step
        t.後に戻る(); // step`,
    `const t = new Turtle(); registerDisplayRef('t', () => t); // step
t.turnRight();
t.turnRight();
t.backward();
t.backward();`
  ),
  define(
    1,
    'OppositeBackward',
    '反対を向いて戻る',
    3,
    `        Turtle t = new Turtle(); // step
        t.右を向く(); // step
        t.右を向く(); // step
        t.後に戻る(); // step
        t.後に戻る(); // step
        t.後に戻る(); // step`,
    `const t = new Turtle(); registerDisplayRef('t', () => t); // step
t.turnRight();
t.turnRight();
t.backward();
t.backward();
t.backward();`
  ),
  ...[1, 2, 3].map((variant) =>
    define(
      2,
      'CoordinateRead',
      '座標の値を読む',
      variant,
      `        int value = ${variant}; // step
        Turtle t = new Turtle(value, 1); // step
        t.右を向く(); // step`,
      `s.set('value', ${variant});
const t = new Turtle(s.get('value'), 1); registerDisplayRef('t', () => t); // step
t.turnRight();`
    )
  ),
  ...[1, 2, 3].map((variant) =>
    define(
      2,
      'UpdateAfterCreation',
      '値を一度増やす',
      variant,
      `        int value = ${variant}; // step
        Turtle t = new Turtle(value, 1); // step
        value++; // step`,
      `s.set('value', ${variant});
const t = new Turtle(s.get('value'), 1); registerDisplayRef('t', () => t); // step
s.set('value', s.get('value') + 1);`
    )
  ),
  ...[1, 2, 3].map((variant) =>
    define(
      2,
      'ReadUpdatedExpression',
      '更新した値から計算する',
      variant,
      `        Turtle t = new Turtle(${variant}, 1); // step
        int value = ${variant}; // step
        value++; // step
        int next = value + 1; // step`,
      `const t = new Turtle(${variant}, 1); registerDisplayRef('t', () => t); // step
s.set('value', ${variant});
s.set('value', s.get('value') + 1);
s.set('next', s.get('value') + 1);`
    )
  ),
  ...[1, 2, 3].map((variant) =>
    define(
      3,
      'Countdown',
      '残りの回数を減らす',
      variant,
      `        Turtle t = new Turtle(1, 1); // step
        int remaining = ${variant}; // step
        while (remaining > 0) {
            t.前に進む(); // step
            remaining--; // step
        }`,
      `const t = new Turtle(1, 1); registerDisplayRef('t', () => t); // step
s.set('remaining', ${variant});
while (s.get('remaining') > 0) {
  t.forward();
  s.set('remaining', s.get('remaining') - 1);
}`
    )
  ),
  ...[1, 2, 3].map((variant) =>
    define(
      3,
      'RepeatedTurn',
      '同じ向きに回る',
      variant,
      `        Turtle t = new Turtle(1, 1); // step
        for (int i = 0; i < ${variant}; i++) { // step
            t.右を向く(); // step
        }`,
      `const t = new Turtle(1, 1); registerDisplayRef('t', () => t); // step
for (s.set('i', 0); s.get('i') < ${variant}; s.set('i', s.get('i') + 1)) {
  t.turnRight();
}
delete s.vars['i'];`
    )
  ),
  ...[1, 2, 3].map((variant) =>
    define(
      3,
      'RepeatedIncrement',
      '値を一ずつ増やす',
      variant,
      `        Turtle t = new Turtle(1, 1); // step
        int value = 0; // step
        for (int i = 0; i < ${variant}; i++) { // step
            value++; // step
        }`,
      `const t = new Turtle(1, 1); registerDisplayRef('t', () => t); // step
s.set('value', 0);
for (s.set('i', 0); s.get('i') < ${variant}; s.set('i', s.get('i') + 1)) {
  s.set('value', s.get('value') + 1);
}
delete s.vars['i'];`
    )
  ),
  ...[1, 2, 3].map((variant) =>
    define(
      4,
      'SingleChoice',
      '条件で向きを変える',
      variant,
      `        Turtle t = new Turtle(1, 1); // step
        int value = ${variant}; // step
        if (value > 1) {
            t.右を向く(); // step
        }
        t.前に進む(); // step`,
      `const t = new Turtle(1, 1); registerDisplayRef('t', () => t); // step
s.set('value', ${variant});
if (s.get('value') > 1) {
  t.turnRight();
}
t.forward();`
    )
  ),
  ...[1, 2, 3].map((variant) =>
    define(
      4,
      'UpdatedChoice',
      '更新後の値で選ぶ',
      variant,
      `        Turtle t = new Turtle(1, 1); // step
        int value = ${variant}; // step
        value--; // step
        if (value == 2) {
            t.右を向く(); // step
        }
        t.前に進む(); // step`,
      `const t = new Turtle(1, 1); registerDisplayRef('t', () => t); // step
s.set('value', ${variant});
s.set('value', s.get('value') - 1);
if (s.get('value') === 2) {
  t.turnRight();
}
t.forward();`
    )
  ),
  ...[1, 2, 3].map((variant) =>
    define(
      4,
      'NestedTurns',
      '二重の繰り返し',
      variant,
      `        Turtle t = new Turtle(1, 1); // step
        for (int row = 0; row < ${['1', '2', '2'][variant - 1]}; row++) { // step
            for (int column = 0; column < ${['2', '1', '2'][variant - 1]}; column++) { // step
                t.右を向く(); // step
            }
        }`,
      `const t = new Turtle(1, 1); registerDisplayRef('t', () => t); // step
for (s.set('row', 0); s.get('row') < ${['1', '2', '2'][variant - 1]}; s.set('row', s.get('row') + 1)) {
  for (s.set('column', 0); s.get('column') < ${['2', '1', '2'][variant - 1]}; s.set('column', s.get('column') + 1)) {
    t.turnRight();
  }
  delete s.vars['column'];
}
delete s.vars['row'];`
    )
  ),
  ...[1, 2, 3].map((variant) =>
    define(
      5,
      'EitherDirection',
      '二つの向きから選ぶ',
      variant,
      `        Turtle t = new Turtle(2, 2); // step
        int value = ${variant}; // step
        if (value > 1) {
            t.右を向く(); // step
        } else {
            t.左を向く(); // step
        }`,
      `const t = new Turtle(2, 2); registerDisplayRef('t', () => t); // step
s.set('value', ${variant});
if (s.get('value') > 1) {
  t.turnRight();
} else {
  t.turnLeft();
}`
    )
  ),
  ...[1, 2, 3].map((variant) =>
    define(
      5,
      'ThreeChoices',
      '三つの動作から選ぶ',
      variant,
      `        Turtle t = new Turtle(2, 2); // step
        int value = ${variant}; // step
        if (value == 1) {
            t.前に進む(); // step
        } else if (value == 2) {
            t.右を向く(); // step
        } else {
            t.後に戻る(); // step
        }`,
      `const t = new Turtle(2, 2); registerDisplayRef('t', () => t); // step
s.set('value', ${variant});
if (s.get('value') === 1) {
  t.forward();
} else if (s.get('value') === 2) {
  t.turnRight();
} else {
  t.backward();
}`
    )
  ),
  ...[1, 2, 3].map((variant) =>
    define(
      5,
      'SingleSwitch',
      '番号で動作を選ぶ',
      variant,
      `        Turtle t = new Turtle(2, 2); // step
        int value = ${variant}; // step
        switch (value) {
            case 1:
                t.左を向く(); // step
                break;
            case 2:
                t.後に戻る(); // step
                break;
            default:
                t.右を向く(); // step
                break;
        }`,
      `const t = new Turtle(2, 2); registerDisplayRef('t', () => t); // step
s.set('value', ${variant});
switch (s.get('value')) {
  case 1:
    t.turnLeft();
    break;
  case 2:
    t.backward();
    break;
  default:
    t.turnRight();
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
      `        Turtle t = new Turtle(2, 2); // step
        for (int i = 1; i <= 3; i++) { // step
            if (i == ${variant}) {
                break;
            }
            t.右を向く(); // step
        }`,
      `const t = new Turtle(2, 2); registerDisplayRef('t', () => t); // step
for (s.set('i', 1); s.get('i') <= 3; s.set('i', s.get('i') + 1)) {
  if (s.get('i') === ${variant}) {
    break;
  }
  t.turnRight();
}
delete s.vars['i'];`
    )
  ),
  ...[1, 2, 3].map((variant) =>
    define(
      6,
      'SkipTurn',
      '残りの動作を飛ばす',
      variant,
      `        Turtle t = new Turtle(2, 2); // step
        for (int i = 1; i <= ${variant}; i++) { // step
            t.前に進む(); // step
            if (i == 1) {
                continue;
            }
            t.右を向く(); // step
        }`,
      `const t = new Turtle(2, 2); registerDisplayRef('t', () => t); // step
for (s.set('i', 1); s.get('i') <= ${variant}; s.set('i', s.get('i') + 1)) {
  t.forward();
  if (s.get('i') === 1) {
    continue;
  }
  t.turnRight();
}
delete s.vars['i'];`
    )
  ),
  ...[1, 2, 3].map((variant) =>
    define(
      6,
      'ContinueUpdate',
      '飛ばした後も回数を増やす',
      variant,
      `        Turtle t = new Turtle(2, 2); // step
        int i = 0; // step
        for (; i < ${variant}; i++) { // step
            if (i < 1) {
                continue;
            }
            t.右を向く(); // step
        }`,
      `const t = new Turtle(2, 2); registerDisplayRef('t', () => t); // step
s.set('i', 0);
for (; s.get('i') < ${variant}; s.set('i', s.get('i') + 1)) {
  if (s.get('i') < 1) {
    continue;
  }
  t.turnRight();
}`
    )
  ),
  ...[1, 2, 3].map((variant) =>
    define(
      7,
      'LocalHelper',
      '引数なしで呼び出す',
      variant,
      `        place(); // caller`,
      `call(place)();

function place() {
  const t = new Turtle(${variant}, 1); registerDisplayRef('t', () => t); // step
  t.turnRight();
}`,
      `    static void place() {
        Turtle t = new Turtle(${variant}, 1); // step
        t.右を向く(); // step
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
      `        place(${variant}); // caller`,
      `call(place, 'x')(${variant});

function place(x) {
  const t = new Turtle(x, 1); registerDisplayRef('t', () => t); // step
  t.turnLeft();
}`,
      `    static void place(int x) {
        Turtle t = new Turtle(x, 1); // step
        t.左を向く(); // step
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
      `        Turtle t = new Turtle(2, 2); // step
        int result = next(${variant}); // step // caller`,
      `const t = new Turtle(2, 2); registerDisplayRef('t', () => t); // step
s.set('result', call(next, 'value')(${variant}));

function next(value) {
  return value + 1;
}`,
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
      `        Turtle t = new Turtle(2, 2); // step
        int[] values = {1, 2, 3}; // step
        int selected = values[${variant - 1}]; // step`,
      `const t = new Turtle(2, 2); registerDisplayRef('t', () => t); // step
s.set('values', [1, 2, 3]);
s.set('selected', s.get('values')[${variant - 1}]);`
    )
  ),
  ...[1, 2, 3].map((variant) =>
    define(
      8,
      'ReplaceCell',
      '配列の一つを置き換える',
      variant,
      `        Turtle t = new Turtle(2, 2); // step
        int[] values = {0, 0, 0}; // step
        values[1] = ${variant}; // step
        int selected = values[1]; // step`,
      `const t = new Turtle(2, 2); registerDisplayRef('t', () => t); // step
s.set('values', [0, 0, 0]);
s.get('values')[1] = ${variant}; // step
s.set('selected', s.get('values')[1]);`
    )
  ),
  ...[1, 2, 3].map((variant) =>
    define(
      8,
      'StringLength',
      '文字列の長さを読む',
      variant,
      `        Turtle t = new Turtle(2, 2); // step
        String word = ${['"a"', '"ab"', '"abc"'][variant - 1]}; // step
        int length = word.length(); // step`,
      `const t = new Turtle(2, 2); registerDisplayRef('t', () => t); // step
s.set('word', ${["'a'", "'ab'", "'abc'"][variant - 1]});
s.set('length', s.get('word').length);`
    )
  ),
] satisfies PracticeDefinition[];
