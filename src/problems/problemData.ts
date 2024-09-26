export const courseIds = ['tuBeginner1', 'tuBeginner2'] as const;
export type CourseId = (typeof courseIds)[number];

export const problemIds = [
  'straight',
  'stepBack',
  'turnRight',
  'turnRightAndTurnLeft',
  'square1',
  'square2',
  'variable',
  'variable2',
  'variable3',
  'while1',
  'while2',
  'while3',
  'while4',
  'while5',
  'for1',
  'for2',
  'for3',
  'for4',
  'for5',
  'doubleLoop1',
  'doubleLoop2',
  'if1',
  'if2',
  'elseIf1',
  'elseIf2',
  'switch1',
  'switch2',
  'break1',
  'break2',
  'break3',
  'continue1',
  'continue2',
  'continue3',
  'method1',
  'method2',
  'method3',
  'return1',
  'return2',
  'return3',
  'array1',
  'array2',
  'array3',
  'string1',
  'string2',
  'string3',
  'test1',
  'test2',
  'test3',
  'test4',
  'test5',
] as const;
export type ProblemId = (typeof problemIds)[number];

export const languageIds = ['instrumented', 'java'] as const;
export type LanguageId = (typeof languageIds)[number];

export const courseIdToName: Record<CourseId, string> = {
  tuBeginner1: '初級プログラミングⅠ',
  tuBeginner2: '初級プログラミングⅡ',
};

export const problemIdToName: Record<ProblemId, string> = {
  straight: '線を描こう(1)',
  stepBack: '線を描こう(2)',
  turnRight: '線を描こう(3)',
  turnRightAndTurnLeft: '線を描こう(4)',
  square1: '図形を描こう(1)',
  square2: '図形を描こう(2)',
  variable: '変数を使おう(1)',
  variable2: '変数を使おう(2)',
  variable3: '変数を使おう(3)',
  while1: 'while文を使おう(1)',
  while2: 'while文を使おう(2)',
  while3: 'while文を使おう(3)',
  while4: 'while文を使おう(4)',
  while5: 'while文を使おう(5)',
  for1: 'for文を使おう(1)',
  for2: 'for文を使おう(2)',
  for3: 'for文を使おう(3)',
  for4: 'for文を使おう(4)',
  for5: 'for文を使おう(5)',
  doubleLoop1: '二重ループ(1)',
  doubleLoop2: '二重ループ(2)',
  if1: 'if文を使おう(1)',
  if2: 'if文を使おう(2)',
  elseIf1: 'else if文を使おう(1)',
  elseIf2: 'else if文を使おう(2)',
  switch1: 'switch文を使おう(1)',
  switch2: 'switch文を使おう(2)',
  break1: 'break文を使おう(1)',
  break2: 'break文を使おう(2)',
  break3: 'break文を使おう(3)',
  continue1: 'continue文を使おう(1)',
  continue2: 'continue文を使おう(2)',
  continue3: 'continue文を使おう(3)',
  method1: 'メソッドを使おう(1)',
  method2: 'メソッドを使おう(2)',
  method3: 'メソッドを使おう(3)',
  return1: 'return文を使おう(1)',
  return2: 'return文を使おう(2)',
  return3: 'return文を使おう(3)',
  array1: '配列を使おう(1)',
  array2: '配列を使おう(2)',
  array3: '配列を使おう(3)',
  string1: '文字列を使おう(1)',
  string2: '文字列を使おう(2)',
  string3: '文字列を使おう(3)',
  test1: 'ステップ実行のテスト用問題(1)',
  test2: 'ステップ実行のテスト用問題(2)',
  test3: 'ステップ実行のテスト用問題(3)',
  test4: 'ステップ実行のテスト用問題(4)',
  test5: 'チェックポイント取得のテスト用問題',
};

export const courseIdToLectureIndexToProblemIds: Record<CourseId, ProblemId[][]> = {
  tuBeginner1: [
    ['straight', 'stepBack', 'turnRight', 'turnRightAndTurnLeft'],
    ['square1', 'square2', 'variable', 'variable2', 'variable3'],
    ['while1', 'while2', 'while3', 'while4', 'while5', 'for1', 'for2', 'for3', 'for4', 'for5'],
    ['doubleLoop1', 'doubleLoop2', 'if1', 'if2'],
    ['elseIf1', 'elseIf2', 'switch1', 'switch2'],
    ['break1', 'break2', 'break3', 'continue1', 'continue2', 'continue3'],
    ['method1', 'method2', 'method3', 'return1', 'return2', 'return3'],
    ['array1', 'array2', 'array3', 'string1', 'string2', 'string3'],
  ],
  tuBeginner2: [['test1', 'test2', 'test3', 'test4', 'test5']],
};

export const courseIdToLectureIds: Record<CourseId, string[]> = JSON.parse(
  process.env.NEXT_PUBLIC_COURSE_ID_TO_LECTURE_IDS_JSON ?? '{}'
);

export const problemIdToLanguageIdToProgram: Record<ProblemId, Record<LanguageId, string>> = {
  straight: {
    instrumented: `
s.set('亀', new Turtle());
s.get('亀').forward();
s.get('亀').forward();
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(); // sid
        亀.前に進む(); // sid
        亀.前に進む(); // sid
    }
}
    `.trim(),
  },
  stepBack: {
    instrumented: `
s.set('亀', new Turtle());
s.get('亀').forward();
s.get('亀').backward();
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(); // sid
        亀.前に進む(); // sid
        亀.後に戻る(); // sid
    }
}
    `.trim(),
  },
  turnRight: {
    instrumented: `
s.set('亀', new Turtle());
s.get('亀').forward();
s.get('亀').turnRight();
s.get('亀').forward();
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(); // sid
        亀.前に進む(); // sid
        亀.右を向く(); // sid
        亀.前に進む(); // sid
    }
}
    `.trim(),
  },
  turnRightAndTurnLeft: {
    instrumented: `
s.set('亀', new Turtle());
s.get('亀').turnRight();
s.get('亀').forward();
s.get('亀').turnLeft();
s.get('亀').forward();
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(); // sid
        亀.右を向く(); // sid
        亀.前に進む(); // sid
        亀.左を向く(); // sid
        亀.前に進む(); // sid
    }
}
    `.trim(),
  },
  square1: {
    instrumented: `
s.set('亀', new Turtle());
s.get('亀').forward();
s.get('亀').turnRight();
s.get('亀').forward();
s.get('亀').turnRight();
s.get('亀').forward();
`.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(); // sid
        亀.前に進む(); // sid
        亀.右を向く(); // sid
        亀.前に進む(); // sid
        亀.右を向く(); // sid
        亀.前に進む(); // sid
    }
}
    `.trim(),
  },
  square2: {
    instrumented: `
s.set('亀', new Turtle(<1-5>, <1-4>));
s.get('亀').forward();
s.get('亀').turnRight();
s.get('亀').forward();
s.get('亀').turnRight();
s.get('亀').forward();
`.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(<1-5>, <1-4>); // sid
        亀.前に進む(); // sid
        亀.右を向く(); // sid
        亀.前に進む(); // sid
        亀.右を向く(); // sid
        亀.前に進む(); // sid
    }
}
    `.trim(),
  },
  variable: {
    instrumented: `
s.set('x', <1-5>);
s.set('亀', new Turtle(s.get('x'), <1-5>));
s.get('亀').forward();
 `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        int x = <1-5>; // sid
        Turtle 亀 = new Turtle(x, <1-5>); // sid
        亀.前に進む(); // sid
    }
}
    `.trim(),
  },
  variable2: {
    instrumented: `
s.set('x', <1-4>);
s.set('x', s.get('x') + 1);
s.set('y', s.get('x') + 1);
s.set('亀', new Turtle(s.get('x'), s.get('y')));
s.get('亀').forward();
`.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        int x = <1-4>; // sid
        x = x + 1; // sid
        int y = x + 1; // sid
        Turtle 亀 = new Turtle(x, y); // sid
        亀.前に進む(); // sid
    }
}
    `.trim(),
  },
  variable3: {
    instrumented: `
s.set('x', <1-5>);
s.set('x', s.get('x') - 1);
s.set('y', s.get('x') * 2);
s.set('y', Math.floor(s.get('y') / 3));
s.set('亀', new Turtle(s.get('x'), s.get('y')));
s.get('亀').forward();
`.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        int x = <1-5>; // sid
        x--; // sid
        int y = x * 2; // sid
        y /= 3; // sid
        Turtle 亀 = new Turtle(x, y); // sid
        亀.前に進む(); // sid
    }
}
    `.trim(),
  },
  while1: {
    instrumented: `
s.set('亀', new Turtle());
s.set('i', 0);
while (s.get('i') < <3-5>) {
  s.get('亀').forward();
  s.set('i', s.get('i') + 1);
}
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(); // sid
        int i = 0; // sid
        while (i < <3-5>) {
            亀.前に進む(); // sid
            i++; // sid
        }
    }
}
    `.trim(),
  },
  while2: {
    instrumented: `
s.set('亀', new Turtle());
s.set('i', <1-2>);
while (s.get('i') < <4-6>) {
  s.get('亀').forward();
  s.set('i', s.get('i') + 1);
}
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(); // sid
        int i = <1-2>; // sid
        while (i < <4-6>) {
            亀.前に進む(); // sid
            i++; // sid
        }
    }
}
    `.trim(),
  },
  while3: {
    instrumented: `
s.set('亀', new Turtle());
s.set('i', 0);
while (s.get('i') < <2-3>) {
  s.set('i', s.get('i') + 1);
  s.get('亀').forward();
  s.get('亀').turnRight();
}
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(); // sid
        int i = 0; // sid
        while (i < <2-3>) {
            i++; // sid
            亀.前に進む(); // sid
            亀.右を向く(); // sid
        }
    }
}
    `.trim(),
  },
  while4: {
    instrumented: `
s.set('亀', new Turtle());
s.set('i', <1-2>);
while (s.get('i') < <4-5>) {
  s.get('亀').forward();
  s.get('亀').turnRight();
  s.get('亀').turnLeft();
  s.set('i', s.get('i') + 1);
}
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(); // sid
        int i = <1-2>; // sid
        while (i < <4-5>) {
            亀.前に進む(); // sid
            亀.右を向く(); // sid
            亀.左を向く(); // sid
            i++; // sid
        }
    }
}
    `.trim(),
  },

  for1: {
    instrumented: `
s.set('亀', new Turtle());
for (s.set('i', 0); s.get('i') < <3-5>; s.set('i', s.get('i') + 1)) {
  s.get('亀').forward();
}
       `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(); // sid
        for (int i = 0; i < <3-5>; i++) { // sid
            亀.前に進む(); // sid
        }
    }
}
    `.trim(),
  },
  for2: {
    instrumented: `
s.set('亀', new Turtle());
s.set('i', 0);
for (s.set('i', s.get('i')) ; s.get('i') < <2-3>; s.set('i', s.get('i'))) {
  s.get('亀').forward();
  s.get('亀').turnRight();
  s.set('i', s.get('i') + 1);
}
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(); // sid
        int i = 0; // sid
        for (; i < <2-3>;) { // sid
            亀.前に進む(); // sid
            亀.右を向く(); // sid
            i++; // sid
        }
    }
}
    `.trim(),
  },
  for3: {
    instrumented: `
s.set('x', 0);
for (s.set('i', 2); s.get('i') <= <4-5>; s.set('i', s.get('i') + 1)) {
  s.set('x', s.get('x') + s.get('i'));
}
s.set('x', Math.floor(s.get('x') / 3));
s.set('亀', new Turtle(s.get('x'), 0));
s.get('亀').forward();
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        int x = 0; // sid
        for (int i = 2; i <= <4-5>; i++) { // sid
            x += i; // sid
        }
        x /= 3; // sid
        Turtle 亀 = new Turtle(x, 0); // sid
        亀.前に進む(); // sid
    }
}
    `.trim(),
  },
  doubleLoop1: {
    instrumented: `
s.set('t', new Turtle());
for (s.set('i', 0); s.get('i') < <2-3>; s.set('i', s.get('i') + 1)) {
  for (s.set('j', 0); s.get('j') < <2-3>; s.set('j', s.get('j') + 1)) {
      s.get('t').forward();
  }
  s.get('t').turnRight();
}
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid
        for (int i = 0; i < <2-3>; i++) { // sid
            for (int j = 0; j < <2-3>; j++) { // sid
                t.前に進む(); // sid
            }
            t.右を向く(); // sid
        }
    }
}
    `.trim(),
  },
  doubleLoop2: {
    instrumented: `
s.set('t', new Turtle());
for (s.set('i', <3-4>); s.get('i') > 0; s.set('i', s.get('i') - 1)) {
  for (s.set('j', 0); s.get('j') < s.get('i'); s.set('j', s.get('j') + 1)) {
    s.get('t').forward();
  }
  s.get('t').turnRight();
}
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid
        for (int i = <3-4>; i > 0; i--) { // sid
            for (int j = 0; j < i; j++) { // sid
                t.前に進む(); // sid
            }
            t.右を向く(); // sid
        }
    }
}
    `.trim(),
  },
  if1: {
    instrumented: `
s.set('t', new Turtle());
for (s.set('i', 0); s.get('i') < <7-9>; s.set('i', s.get('i') + 1)) {
  s.get('t').forward();
  if (s.get('i') % 3 === 2) {
    s.get('t').turnRight();
  }
}
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid
        for (int i = 0; i < <7-9>; i++) { // sid
            t.前に進む(); // sid
            if (i % 3 == 2) {
                t.右を向く(); // sid
            }
        }
    }
}
    `.trim(),
  },
  if2: {
    instrumented: `
s.set('t', new Turtle());
for (s.set('i', 0); s.get('i') < 4; s.set('i', s.get('i') + 1)) {
  s.get('t').forward();
  if (s.get('i') % 2 === 0) {
    s.get('t').turnRight();
  } else {
    s.get('t').turnLeft();
  }
}
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid
        for (int i = 0; i < 4; i++) { // sid
            t.前に進む(); // sid
            if (i % 2 == 0) {
                t.右を向く(); // sid
            } else {
                t.左を向く(); // sid
            }
        }
    }
}
    `.trim(),
  },
  elseIf1: {
    instrumented: `
s.set('t', new Turtle());
for (s.set('i', 0); s.get('i') < <4-6>; s.set('i', s.get('i') + 1)) {
  if (s.get('i') < <2-3>) {
    s.get('t').forward();
  } else if (s.get('i') === <2-3>) {
    s.get('t').turnLeft();
  } else {
    s.get('t').backward();
  }
}
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid
        for (int i = 0; i < <4-6>; i++) { // sid
            if (i < <2-3>)            t.前に進む(); // sid
            else if (i == <2-3>)    t.左を向く(); // sid
            else                     t.後に戻る(); // sid
        }
    }
}
    `.trim(),
  },
  elseIf2: {
    instrumented: `
s.set('t', new Turtle());
for (s.set('i', 0); s.get('i') < <5-7>; s.set('i', s.get('i') + 1)) {
  if (s.get('i') % 4 === 0) {
    s.get('t').forward();
  } else if (s.get('i') % 4 === 1) {
    s.get('t').turnRight();
  } else if (s.get('i') % 4 === 2) {
    s.get('t').forward();
  } else {
    s.get('t').turnLeft();
  }
}
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid
        for (int i = 0; i < <5-7>; i++) { // sid
            if (i % 4 == 0)            t.前に進む(); // sid
            else if (i % 4 == 1)    t.右を向く(); // sid
            else if (i % 4 == 2)    t.前に進む(); // sid
            else                        t.左を向く(); // sid
        }
    }
}
    `.trim(),
  },
  switch1: {
    instrumented: `
s.set('t', new Turtle());
for (s.set('i', 0); s.get('i') < <5-7>; s.set('i', s.get('i') + 1)) {
  switch (s.get('i')) {
    case 0: case 1:
      s.get('t').forward(); break;
    case 2:
      s.get('t').turnLeft(); break;
    default:
      s.get('t').backward(); break;
  }
}
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid
        for (int i = 0; i < <5-7>; i++) { // sid
            switch (i) {
                case 0: case 1:
                    t.前に進む(); break; // sid
                case 2:
                    t.左を向く(); break; // sid
                default:
                    t.後に戻る(); break; // sid
            }
        }
    }
}
    `.trim(),
  },
  switch2: {
    instrumented: `
s.set('t', new Turtle());
for (s.set('i', 0); s.get('i') < <5-7>; s.set('i', s.get('i') + 1)) {
  switch (s.get('i') % 4) {
    case 1:
      s.get('t').turnRight(); break;
    case 3:
      s.get('t').turnLeft(); break;
    default:
      s.get('t').forward(); break;
  }
}
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid
        for (int i = 0; i < <5-7>; i++) { // sid
            switch (i % 4) {
                case 1:
                    t.右を向く(); break; // sid
                case 3:
                    t.左を向く(); break; // sid
                default:
                    t.前に進む(); break; // sid
            }
        }
    }
}
    `.trim(),
  },
  break1: {
    instrumented: `
s.set('t', new Turtle());
while (true) {
  if (!s.get('t').canMoveForward()) break;
  s.get('t').forward();
}
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid
        while (true) {
            if (!t.前に進めるか()) break;
            t.前に進む(); // sid
        }
    }
}
    `.trim(),
  },
  break2: {
    instrumented: `
s.set('t', new Turtle(<3-4>,<3-4>));
while (true) {
  if (!s.get('t').canMoveForward()) break;
  s.get('t').forward();
  s.get('t').turnRight();

  if (!s.get('t').canMoveForward()) break;
  s.get('t').forward();
  s.get('t').turnLeft();
}
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(<3-4>, <3-4>); // sid
        while (true) {
            if (!t.前に進めるか()) break;
            t.前に進む(); // sid
            t.右を向く(); // sid

            if (!t.前に進めるか()) break;
            t.前に進む(); // sid
            t.左を向く(); // sid
        }
    }
}
    `.trim(),
  },
  break3: {
    instrumented: `
s.set('t', new Turtle(<4-6>, <4-6>));
for (s.set('i', 0); s.get('i') < 4; s.set('i', s.get('i') + 1)) {
  while (true) {
    s.get('t').forward();
    if (!s.get('t').canMoveForward()) break;
  }
  s.get('t').turnRight();
}
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(<4-6>, <4-6>); // sid
        for (int i = 0; i < 4; i++) { // sid
            for (;;) {
                t.前に進む(); // sid
                if (!t.前に進めるか()) break;
            }
            t.右を向く(); // sid
        }
    }
}
    `.trim(),
  },
  continue1: {
    instrumented: `
s.set('t', new Turtle());
  for (s.set('i', 0); s.get('i') < <3-5>; s.set('i', s.get('i') + 1)) {
    if (s.get('i') == 0) {
      continue;
    }
  s.get('t').forward();
}
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid
        for (int i = 0; i < <3-5>; i++) { // sid
            if (i == 0) {
                continue;
            }
            t.前に進む(); // sid
        }
    }
}
    `.trim(),
  },
  continue2: {
    instrumented: `
s.set('t', new Turtle());
for (s.set('i', 0); s.get('i') < <5-7>; s.set('i', s.get('i') + 1)) {
  if (s.get('i') % <2-3> == 1) {
    s.get('t').turnRight();
    continue;
  }
  s.get('t').forward();
}
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid
        for (int i = 0; i < <5-7>; i++) { // sid
            if (i % <2-3> == 1) {
                t.右を向く(); // sid
                continue;
            }
            t.前に進む(); // sid
        }
    }
}
    `.trim(),
  },
  continue3: {
    instrumented: `
s.set('t', new Turtle());
for (s.set('i', 0); s.get('i') < 2; s.set('i', s.get('i') + 1)) {
  for (s.set('j', s.get('i') * 4); s.get('j') < 8; s.set('j', s.get('j') + 1)) {
    if (s.get('j') % 4 == 1) {
      s.get('t').turnRight(); continue;
    } else if (s.get('j') % 4 == 3) {
      s.get('t').turnLeft(); continue;
    }
    s.get('t').forward();
  }
  s.get('t').turnLeft();
}
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid
        for (int i = 0; i < 2; i++) { // sid
            for (int j = i * 4; j < 8; j++) { // sid
                if (j % 4 == 1) {
                    t.右を向く(); continue; // sid
                } else if (j % 4 == 3) {
                    t.左を向く(); continue; // sid
                }
                t.前に進む(); // sid
            }
            t.左を向く(); // sid
        }
    }
}
    `.trim(),
  },
  method1: {
    instrumented: `
s.set('t', new Turtle());
forwardTwoSteps(s.get('t'));
s.get('t').turnRight();
threeStepsForward(s.get('t'));

function forwardTwoSteps(t) {
  try {
    s.enterNewScope([['t', t]]);
    t.forward();
    t.forward();
  } finally {
    s.leaveScope();
  }
}

function threeStepsForward(t) {
  try {
    s.enterNewScope([['t', t]]);
    t.forward();
    t.forward();
    t.forward();
  } finally {
    s.leaveScope();
  }
}
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid: 1
        二歩前に進める(t);
        t.右を向く(); // sid: 2
        三歩前に進める(t);
    }
    static void 二歩前に進める(Turtle t) {
        t.前に進む(); // sid: 3
        t.前に進む(); // sid: 4
    }
    static void 三歩前に進める(Turtle t) {
        t.前に進む(); // sid: 5
        t.前に進む(); // sid: 6
        t.前に進む(); // sid: 7
    }
}
    `.trim(),
  },
  method2: {
    instrumented: `
s.set('t', new Turtle());
forwardGivenSteps(s.get('t'), <3-4>);
s.get('t').turnRight();
forwardGivenSteps(s.get('t'), 2);

function forwardGivenSteps(t, n) {
  try {
    s.enterNewScope([['t', t], ['n', n]]);
    for (s.set('i', 0); s.get('i') < n; s.set('i', s.get('i') + 1)) {
      t.forward();
    }
  } finally {
    s.leaveScope();
  }
}
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid
        N歩前に進める(t, <3-4>);
        t.右を向く(); // sid
        N歩前に進める(t, 2);
    }

    static void N歩前に進める(Turtle t, int n) {
        for (int i = 0; i < n; i++) { // sid
            t.前に進む(); // sid
        }
    }
}
    `.trim(),
  },
  method3: {
    instrumented: `
s.set('t', new Turtle());
forwardTwoSteps(s.get('t'));
s.get('t').turnRight();
forwardFourSteps(s.get('t'));

function forwardTwoSteps(t) {
  try {
    s.enterNewScope([['t', t]]);
    t.forward();
    t.forward();
  } finally {
    s.leaveScope();
  }
}

function forwardFourSteps(t) {
  try {
    s.enterNewScope([['t', t]]);
    forwardTwoSteps(t);
    forwardTwoSteps(t);
  } finally {
    s.leaveScope();
  }
}
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid
        二歩前に進める(t);
        t.右を向く(); // sid
        四歩前に進める(t);
    }
    static void 二歩前に進める(Turtle t) {
        t.前に進む(); // sid
        t.前に進む(); // sid
    }
    static void 四歩前に進める(Turtle t) {
        二歩前に進める(t);
        二歩前に進める(t);
    }
}
    `.trim(),
  },
  return1: {
    instrumented: `
s.set('t', new Turtle());
s.set('x', double(<2-3>));
forwardGivenSteps(s.get('t'), s.get('x'));

function forwardGivenSteps(t, n) {
  try {
    s.enterNewScope([['t', t], ['n', n]]);
    for (s.set('i', 0); s.get('i') < n; s.set('i', s.get('i') + 1)) {
      t.forward();
    }
  } finally {
    s.leaveScope();
  }
}

function double(a) {
  try {
    s.enterNewScope([['a', a]]);
    return a * 2;
  } finally {
    s.leaveScope();
  }
}
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid
        int x = 二倍する(<2-3>); // sid
        N歩前に進める(t, x);
    }
    static void N歩前に進める(Turtle t, int n) {
        for (int i = 0; i < n; i++) { // sid
            t.前に進む(); // sid
        }
    }
    static int 二倍する(int a) {
        return a * 2;
    }
}
    `.trim(),
  },
  return2: {
    instrumented: `
s.set('t', new Turtle());
forwardGivenSteps(s.get('t'), add(1, 1));
forwardGivenSteps(s.get('t'), add(1, 2));

function forwardGivenSteps(t, n) {
  try {
    s.enterNewScope([['t', t], ['n', n]]);
    for (s.set('i', 0); s.get('i') < n; s.set('i', s.get('i') + 1)) {
      t.forward();
    }
  } finally {
    s.leaveScope();
  }
}

function add(a, b) {
  try {
    s.enterNewScope([['a', a], ['b', b]]);
    return a + b;
  } finally {
    s.leaveScope();
  }
}
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid
        N歩前に進める(t, 加算する(1, 1));
        N歩前に進める(t, 加算する(1, 2));
    }
    static void N歩前に進める(Turtle t, int n) {
        for (int i = 0; i < n; i++) { // sid
            t.前に進む(); // sid
        }
    }
    static int 加算する(int a, int b) {
        return a + b; // sid
    }
}
    `.trim(),
  },
  return3: {
    instrumented: `
s.set('t', new Turtle());
for (s.set('i', 0); s.get('i') < 3; s.set('i', s.get('i') + 1)) {
  for (s.set('j', 0); s.get('j') < 3; s.set('j', s.get('j') + 1)) {
    if (isEqual(s.get('i'), s.get('j')))
      s.get('t').turnRight();
    else
      forwardTwoSteps(s.get('t'));
  }
  s.get('t').turnLeft();
}

function forwardTwoSteps(t) {
  try {
    s.enterNewScope([['t', t]]);
    t.forward();
    t.forward();
  } finally {
    s.leaveScope();
  }
}

function isEqual(a, b) {
  try {
    s.enterNewScope([['a', a], ['b', b]]);
    return a == b;
  } finally {
    s.leaveScope();
  }
}
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid
        for (int i = 0; i < 3; i++) { // sid
            for (int j = 0; j < 3; j++) { // sid
                if (等しいか(i, j))
                    t.右を向く(); // sid
                else
                    二歩前に進める(t);
            }
            t.左を向く(); // sid
        }
    }
    static void 二歩前に進める(Turtle t) {
        t.前に進む(); // sid
        t.前に進む(); // sid
    }
    static boolean 等しいか(int a, int b) {
        return a == b;
    }
}
    `.trim(),
  },
  array1: {
    instrumented: `
s.set('t', new Turtle());
s.set('arr', [2, <1-2>, <1-2>]);
for (s.set('i', 0); s.get('i') < s.get('arr').length; s.set('i', s.get('i') + 1)) {
  forwardGivenSteps(s.get('t'), s.get('arr')[s.get('i')]);
  s.get('t').turnRight();
}

function forwardGivenSteps(t, n) {
  try {
    s.enterNewScope([['t', t], ['n', n]]);
    for (s.set('i', 0); s.get('i') < n; s.set('i', s.get('i') + 1)) {
      t.forward();
    }
  } finally {
    s.leaveScope();
  }
}
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid
        int[] arr = { 2, <1-2>, <1-2> }; // sid
        for (int i = 0; i < arr.length; i++) { // sid
            N歩前に進める(t, arr[i]);
            t.右を向く(); // sid
        }
    }
    static void N歩前に進める(Turtle t, int n) {
        for (int i = 0; i < n; i++) { // sid
            t.前に進む(); // sid
        }
    }
}
    `.trim(),
  },
  array2: {
    instrumented: `
s.set('t', new Turtle());
s.set('arr', [0, 1, 0, 2, 0]);
for (s.set('i', 0); s.get('i') < s.get('arr').length; s.set('i', s.get('i') + 1)) {
  switch (s.get('arr')[s.get('i')]) {
    case 0:
      s.get('t').forward(); break;
    case 1:
      s.get('t').turnRight(); break;
    case 2:
      s.get('t').turnLeft(); break;
  }
}
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid
        int[] arr = { 0, 1, 0, 2, 0 }; // sid
        for (int i = 0; i < arr.length; i++) { // sid
            switch (arr[i]) {
                case 0:
                    t.前に進む(); break; // sid
                case 1:
                    t.右を向く(); break; // sid
                case 2:
                    t.左を向く(); break; // sid
            }
        }
    }
}
    `.trim(),
  },
  array3: {
    instrumented: `
s.set('t', new Turtle());
s.set('arr', [0, 1, 0, 2, 0]);
for (const cmd of [0, 1, 0, 2, 0]) {
  s.set('cmd', cmd);
  switch (s.get('cmd')) {
    case 0:
      s.get('t').forward(); break;
    case 1:
      s.get('t').turnRight(); break;
    case 2:
      s.get('t').turnLeft(); break;
  }
}
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid
        int[] arr = { 0, 1, 0, 2, 0 }; // sid
        for (int cmd : arr) { // sid
            switch (cmd) {
                case 0:
                    t.前に進む(); break; // sid
                case 1:
                    t.右を向く(); break; // sid
                case 2:
                    t.左を向く(); break; // sid
            }
        }
    }
}
    `.trim(),
  },
  string1: {
    instrumented: `
s.set('t', new Turtle());
s.set('s', 'frflf');
for (s.set('i', 0); s.get('i') < s.get('s').length; s.set('i', s.get('i') + 1)) {
  switch (s.get('s').charAt(s.get('i'))) {
    case 'f':
      s.get('t').forward(); break;
    case 'r':
      s.get('t').turnRight(); break;
    case 'l':
      s.get('t').turnLeft(); break;
  }
}
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid
        String s = "frflf"; // sid
        for (int i = 0; i < s.length(); i++) { // sid
            switch (s.charAt(i)) {
                case 'f':
                    t.前に進む(); break; // sid
                case 'r':
                    t.右を向く(); break; // sid
                case 'l':
                    t.左を向く(); break; // sid
            }
        }
    }
}
    `.trim(),
  },
  string2: {
    instrumented: `
s.set('t', new Turtle());
s.set('s', 'frflf');
for (const ch of 'frflf') {
  s.set('ch', ch);
  switch (s.get('ch')) {
    case 'f':
      s.get('t').forward(); break;
    case 'r':
      s.get('t').turnRight(); break;
    case 'l':
      s.get('t').turnLeft(); break;
  }
}
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid
        String s = "frflf"; // sid
        for (char ch : s.toCharArray()) { // sid
            switch (ch) {
                case 'f':
                    t.前に進む(); break; // sid
                case 'r':
                    t.右を向く(); break; // sid
                case 'l':
                    t.左を向く(); break; // sid
            }
        }
    }
}
    `.trim(),
  },
  string3: {
    instrumented: `
s.set('t', new Turtle());
s.set('cmds', ['ri', 'aa', 'fo']);
for (const cmd of ['ri', 'aa', 'fo']) {
  s.set('cmd', cmd);
  parse(s.get('t'), s.get('cmd'));
}

function parse(t, c) {
  try {
    s.enterNewScope([['t', t], ['c', c]]);
    if (c === 'fo') t.forward();
    else if (c === 'ri') t.turnRight();
  } finally {
    s.leaveScope();
  }
}
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid
        String[] cmds = { "ri", "aa", "fo" }; // sid
        for (String cmd : cmds) { // sid
            parse(t, cmd);
        }
    }
    static void parse(Turtle t, String c) {
        if (c.equals("fo"))
            t.前に進む(); // sid
        else if (c.equals("ri"))
            t.右を向く(); // sid
    }
}
    `.trim(),
  },
  test1: {
    instrumented: `
s.set('c', new Turtle());
s.get('c').forward();
s.get('c').forward();
s.get('c').forward();
`.trim(),
    // sidがただの連番である場合、番号を省略できる。
    java: `
import net.exkazuu.Character;

public class Main {
  public static void main(String[] args) {
    Character c = new Turtle(); // sid
    c.forward(); // sid
    c.forward(); // sid
    c.forward(); // sid
  }
}
`.trim(),
  },
  test2: {
    instrumented: `
s.set('c', new Turtle());
for (s.set('i', 0); s.get('i') < 2; s.set('i', s.get('i') + 1)) {
  s.get('c').forward();
  s.get('c').forward();
  s.get('c').turnRight();
}
`.trim(),
    java: `
import net.exkazuu.Character;

public class Main {
  public static void main(String[] args) {
    Character c = new Turtle(); // sid
    for (let i = 0; i < 2; i++) { // sid
      c.forward(); // sid
      c.forward(); // sid
      c.turnRight(); // sid
    }
  }
}
`.trim(),
  },
  test3: {
    instrumented: `
s.set('a', 1);
if (s.get('a') > 0) {
  s.set('b', 2);
  s.set('a', f(s.get('a'), s.get('b')));
}
s.set('c', s.get('a') * 2);

function f(x, y) {
  try {
    s.enterNewScope([['x', x], ['y', y]]);
    s.set('a', x * y);
    return s.get('a');
  } finally {
    s.leaveScope();
  }
}
`,
    java: `
import net.exkazuu.Character;

public class Main {
  public static void main(String[] args) {
    int a = 1; // sid: 1
    if (a > 0) {
      int b = 2; // sid: 2
      a = f(a, b); // sid: 3
    }
    int c = a * 2; // sid: 4
  }

  public static int f(int x, int y) {
    int a = x * y; // sid: 5
    return a;
  }
}
`.trim(),
  },
  test4: {
    instrumented: `
s.set('c1', new Turtle());
s.get('c1').forward();
s.get('c1').turnRight();
s.set('i', 0);
s.get('c1').forward();

s.set('c2', new Turtle(2, 3, 'G'));
s.get('c2').forward();
s.set('foo', 'あいうえお');
s.set('bar', <1-100>);
s.set('i', s.get('bar') + 1);
s.get('c2').forward();
s.get('c2').forward();
`.trim(),
    java: `
public class Main {
  public static void main(String[] args) {
    Character c1 = new Turtle(); // sid
    c1.forward(); // sid
    c1.turnRight(); // sid
    int i = 0; // sid
    c1.forward(); // sid

    Character c2 = new Turtle(2, 3, "green"); // sid
    c2.forward(); // sid
    String foo = "あいうえお"; // sid
    int bar = <1-100>; // sid
    i = bar + 1; // sid
    c2.forward(); // sid
    c2.forward(); // sid
  }
}
`.trim(),
  },
  test5: {
    instrumented: `
s.set('c', new Turtle());
s.get('c').forward();
s.get('c').forward();
s.get('c').turnRight();
s.get('c').forward();
s.get('c').forward();
s.get('c').forward();
s.get('c').forward();
`.trim(),
    java: `
public class Straight {
  public static void main(String[] args) {
    var c = new Turtle(); // sid
    c.forward(); // sid
    c.forward(); // sid
    c.turnRight(); // sid
    c.forward(); // sid
    c.forward(); // sid
    c.forward(); // sid
    c.forward(); // sid
  }
}
`.trim(),
  },
};
