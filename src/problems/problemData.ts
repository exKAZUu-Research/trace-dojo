export const courseIds = ['tuBeginner1', 'tuBeginner2', 'test'] as const;
export type CourseId = (typeof courseIds)[number];

export const problemIds = [
  'straight',
  'straight2',
  'stepBack',
  'stepBack2',
  'turnRight',
  'turnRight2',
  'turnLeftAndRight',
  'turnLeftAndRight2',
  'turnLeftAndRight3',
  'turnLeftAndRight4',
  'square1',
  'square2',
  'square3',
  'square4',
  'variable',
  'variable2',
  'variable3',
  'variable4',
  'variable5',
  'variable6',
  'variable7',
  'variable8',
  'variable9',
  'variable10',
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
  'for6',
  'for7',
  'doubleLoop1',
  'doubleLoop2',
  'doubleLoop3',
  'doubleLoop4',
  'doubleLoop5',
  'if1',
  'if2',
  'if3',
  'if4',
  'if5',
  'elseIf1',
  'elseIf2',
  'elseIf3',
  'elseIf4',
  'elseIf5',
  'switch1',
  'switch2',
  'switch3',
  'switch4',
  'switch5',
  'break1',
  'break2',
  'break3',
  'break4',
  'break5',
  'continue1',
  'continue2',
  'continue3',
  'continue4',
  'continue5',
  'method1',
  'method2',
  'method3',
  'method4',
  'method5',
  'return1',
  'return2',
  'return3',
  'return4',
  'return5',
  'array1',
  'array2',
  'array3',
  'array4',
  'array5',
  'string1',
  'string2',
  'string3',
  'string4',
  'string5',
  // 初級プログラミングII 第1回
  'multiObject1',
  'multiObject2',
  'garbageCollection1',
  'oop1',
  'oop2',
  'static2',
  'polymorphism1',
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
  test: '動作確認用',
};

export const problemIdToName: Record<ProblemId, string> = {
  straight: '線を描こう(1)',
  straight2: '線を描こう(2)',
  stepBack: '線を描こう(3)',
  stepBack2: '線を描こう(4)',
  turnRight: '線を描こう(5)',
  turnRight2: '線を描こう(6)',
  turnLeftAndRight: '線を描こう(7)',
  turnLeftAndRight2: '線を描こう(8)',
  turnLeftAndRight3: '線を描こう(9)',
  turnLeftAndRight4: '線を描こう(10)',
  square1: '図形を描こう(1)',
  square2: '図形を描こう(2)',
  square3: '図形を描こう(3)',
  square4: '図形を描こう(4)',
  variable: '変数を使おう(1)',
  variable2: '変数を使おう(2)',
  variable3: '変数を使おう(3)',
  variable4: '変数を使おう(4)',
  variable5: '変数を使おう(5)',
  variable6: '変数を使おう(6)',
  variable7: '変数を使おう(7)',
  variable8: '変数を使おう(8)',
  variable9: '変数を使おう(9)',
  variable10: '変数を使おう(10)',
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
  for6: 'for文を使おう(6)',
  for7: 'for文を使おう(7)',
  doubleLoop1: '二重ループ(1)',
  doubleLoop2: '二重ループ(2)',
  doubleLoop3: '二重ループ(3)',
  doubleLoop4: '二重ループ(4)',
  doubleLoop5: '二重ループ(5)',
  if1: 'if文を使おう(1)',
  if2: 'if文を使おう(2)',
  if3: 'if文を使おう(3)',
  if4: 'if文を使おう(4)',
  if5: 'if文を使おう(5)',
  elseIf1: 'else if文を使おう(1)',
  elseIf2: 'else if文を使おう(2)',
  elseIf3: 'else if文を使おう(3)',
  elseIf4: 'else if文を使おう(4)',
  elseIf5: 'else if文を使おう(5)',
  switch1: 'switch文を使おう(1)',
  switch2: 'switch文を使おう(2)',
  switch3: 'switch文を使おう(3)',
  switch4: 'switch文を使おう(4)',
  switch5: 'switch文を使おう(5)',
  break1: 'break文を使おう(1)',
  break2: 'break文を使おう(2)',
  break3: 'break文を使おう(3)',
  break4: 'break文を使おう(4)',
  break5: 'break文を使おう(5)',
  continue1: 'continue文を使おう(1)',
  continue2: 'continue文を使おう(2)',
  continue3: 'continue文を使おう(3)',
  continue4: 'continue文を使おう(4)',
  continue5: 'continue文を使おう(5)',
  method1: 'メソッドを使おう(1)',
  method2: 'メソッドを使おう(2)',
  method3: 'メソッドを使おう(3)',
  method4: 'メソッドを使おう(4)',
  method5: 'メソッドを使おう(5)',
  return1: 'return文を使おう(1)',
  return2: 'return文を使おう(2)',
  return3: 'return文を使おう(3)',
  return4: 'return文を使おう(4)',
  return5: 'return文を使おう(5)',
  array1: '配列を使おう(1)',
  array2: '配列を使おう(2)',
  array3: '配列を使おう(3)',
  array4: '配列を使おう(4)',
  array5: '配列を使おう(5)',
  string1: '文字列を使おう(1)',
  string2: '文字列を使おう(2)',
  string3: '文字列を使おう(3)',
  string4: '文字列を使おう(4)',
  string5: '文字列を使おう(5)',
  // 初級プログラミングII 第1回
  multiObject1: '複数のオブジェクトを使おう(1)',
  multiObject2: '複数のオブジェクトを使おう(2)',
  garbageCollection1: 'ガベージコレクション',
  oop1: 'オブジェクト指向プログラミング(1)',
  oop2: 'オブジェクト指向プログラミング(2)',
  static2: '静的フィールド(2)',
  polymorphism1: 'ポリモルフィズム(1)',
  test1: 'ステップ実行のテスト用問題(1)',
  test2: 'ステップ実行のテスト用問題(2)',
  test3: 'ステップ実行のテスト用問題(3)',
  test4: 'ステップ実行のテスト用問題(4)',
  test5: 'チェックポイント取得のテスト用問題',
};

export const courseIdToLectureIndexToProblemIds: Record<CourseId, ProblemId[][]> = {
  tuBeginner1: [
    [
      'straight',
      'straight2',
      'stepBack',
      'stepBack2',
      'turnRight',
      'turnRight2',
      'turnLeftAndRight',
      'turnLeftAndRight2',
      'turnLeftAndRight3',
      'turnLeftAndRight4',
    ],
    [
      'square1',
      'square2',
      'square3',
      'square4',
      'variable',
      'variable2',
      'variable3',
      'variable4',
      'variable5',
      'variable6',
      'variable7',
      'variable8',
      'variable9',
      'variable10',
    ],
    ['while1', 'while2', 'while3', 'while4', 'while5', 'for1', 'for2', 'for3', 'for4', 'for5', 'for6', 'for7'],
    ['doubleLoop1', 'doubleLoop2', 'doubleLoop3', 'doubleLoop4', 'doubleLoop5', 'if1', 'if2', 'if3', 'if4', 'if5'],
    ['elseIf1', 'elseIf2', 'elseIf3', 'elseIf4', 'elseIf5', 'switch1', 'switch2', 'switch3', 'switch4', 'switch5'],
    ['break1', 'break2', 'break3', 'break4', 'break5', 'continue1', 'continue2', 'continue3', 'continue4', 'continue5'],
    ['method1', 'method2', 'method3', 'method4', 'method5', 'return1', 'return2', 'return3', 'return4', 'return5'],
    ['array1', 'array2', 'array3', 'array4', 'array5', 'string1', 'string2', 'string3', 'string4', 'string5'],
  ],
  tuBeginner2: [
    // 第1回
    ['multiObject1', 'multiObject2', 'garbageCollection1'],
    // 第2回
    ['oop1'],
    // 第3回
    ['oop1'],
    // 第4回
    ['oop1'],
    // 第5回
    ['oop1'],
    // 第6回
    ['oop1'],
    // 第7回
    ['oop1'],
    // 第8回
    ['oop1'],
  ],
  test: [['test1', 'test2', 'test3', 'test4', 'test5', 'oop1', 'oop2', 'static2', 'polymorphism1']],
};

export const courseIdToLectureIds: Record<CourseId, string[]> = JSON.parse(
  process.env.NEXT_PUBLIC_COURSE_ID_TO_LECTURE_IDS_JSON ?? '{}'
);

export const problemIdToLanguageIdToProgram: Record<ProblemId, Record<LanguageId, string>> = {
  straight: {
    instrumented: `
const t = new Turtle(); // trace
t.forward();
t.forward();
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
  straight2: {
    instrumented: `
const t = new Turtle(); // trace
t.forward();
t.forward();
t.forward();
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(); // sid
        亀.前に進む(); // sid
        亀.前に進む(); // sid
        亀.前に進む(); // sid
    }
}
    `.trim(),
  },
  stepBack: {
    instrumented: `
const t = new Turtle(); // trace
t.forward();
t.backward();
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
  stepBack2: {
    instrumented: `
const t = new Turtle(); // trace
t.forward();
t.forward();
t.backward();
t.forward();
t.forward();
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(); // sid
        亀.前に進む(); // sid
        亀.前に進む(); // sid
        亀.後に戻る(); // sid
        亀.前に進む(); // sid
        亀.前に進む(); // sid
    }
}
    `.trim(),
  },
  turnRight: {
    instrumented: `
const t = new Turtle(); // trace
t.forward();
t.turnRight();
t.forward();
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
  turnRight2: {
    instrumented: `
const t = new Turtle(); // trace
t.forward();
t.forward();
t.turnRight();
t.forward();
t.forward();
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(); // sid
        亀.前に進む(); // sid
        亀.前に進む(); // sid
        亀.右を向く(); // sid
        亀.前に進む(); // sid
        亀.前に進む(); // sid
    }
}
    `.trim(),
  },
  turnLeftAndRight: {
    instrumented: `
const t = new Turtle(); // trace
t.turnRight();
t.forward();
t.turnLeft();
t.forward();
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
  turnLeftAndRight2: {
    instrumented: `
const t = new Turtle(); // trace
t.forward();
t.turnRight();
t.forward();
t.turnLeft();
t.forward();
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(); // sid
        亀.前に進む(); // sid
        亀.右を向く(); // sid
        亀.前に進む(); // sid
        亀.左を向く(); // sid
        亀.前に進む(); // sid
    }
}
    `.trim(),
  },
  turnLeftAndRight3: {
    instrumented: `
const t = new Turtle(); // trace
t.turnRight();
t.forward();
t.turnLeft();
t.forward();
t.turnRight();
t.forward();
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(); // sid
        亀.右を向く(); // sid
        亀.前に進む(); // sid
        亀.左を向く(); // sid
        亀.前に進む(); // sid
        亀.右を向く(); // sid
        亀.前に進む(); // sid
    }
}
    `.trim(),
  },
  turnLeftAndRight4: {
    instrumented: `
const t = new Turtle(); // trace
t.forward();
t.forward();
t.turnRight();
t.forward();
t.forward();
t.turnLeft();
t.forward();
t.forward();
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(); // sid
        亀.前に進む(); // sid
        亀.前に進む(); // sid
        亀.右を向く(); // sid
        亀.前に進む(); // sid
        亀.前に進む(); // sid
        亀.左を向く(); // sid
        亀.前に進む(); // sid
        亀.前に進む(); // sid
    }
}
    `.trim(),
  },
  square1: {
    instrumented: `
const t = new Turtle(); // trace
t.forward();
t.turnRight();
t.forward();
t.turnRight();
t.forward();
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
const t = new Turtle(<1-5>, <1-4>); // trace
t.forward();
t.turnRight();
t.forward();
t.turnRight();
t.forward();
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
  square3: {
    instrumented: `
const t = new Turtle(<2-5>, <2-5>); // trace
t.forward();
t.turnLeft();
t.forward();
t.turnLeft();
t.forward();
t.turnLeft();
t.forward();
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(<2-5>, <2-5>); // sid
        亀.前に進む(); // sid
        亀.左を向く(); // sid
        亀.前に進む(); // sid
        亀.左を向く(); // sid
        亀.前に進む(); // sid
        亀.左を向く(); // sid
        亀.前に進む(); // sid
    }
}
    `.trim(),
  },
  square4: {
    instrumented: `
const t = new Turtle(); // trace
t.forward();
t.forward();
t.turnRight();
t.forward();
t.forward();
t.turnRight();
t.forward();
t.forward();
t.turnRight();
t.forward();
t.forward();
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(); // sid
        亀.前に進む(); // sid
        亀.前に進む(); // sid
        亀.右を向く(); // sid
        亀.前に進む(); // sid
        亀.前に進む(); // sid
        亀.右を向く(); // sid
        亀.前に進む(); // sid
        亀.前に進む(); // sid
        亀.右を向く(); // sid
        亀.前に進む(); // sid
        亀.前に進む(); // sid
    }
}
    `.trim(),
  },

  variable: {
    instrumented: `
s.set('x', <1-5>);
const t = new Turtle(s.get('x'), <1-5>); // trace
t.forward();
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
s.set('a', <2-6>);
s.set('a', s.get('a') - 1);
const t = new Turtle(<1-5>, s.get('a')); // trace
t.forward();
 `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        int a = <2-6>; // sid
        a = a - 1; // sid
        Turtle 亀 = new Turtle(<1-5>, a); // sid
        亀.前に進む(); // sid
    }
}
    `.trim(),
  },
  variable3: {
    instrumented: `
s.set('x', <1-4>);
s.set('x', s.get('x') + 1);
s.set('y', s.get('x') + 1);
const t = new Turtle(s.get('x'), s.get('y')); // trace
t.forward();
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
  variable4: {
    instrumented: `
s.set('b', <1-4>);
s.set('b', s.get('b') + 1);
s.set('a', s.get('b') - 2);
const t = new Turtle(s.get('a') + 1, s.get('b')); // trace
t.forward();
`.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        int b = <1-4>; // sid
        b = b + 1; // sid
        int a = b - 2; // sid
        Turtle 亀 = new Turtle(a + 1, b); // sid
        亀.前に進む(); // sid
    }
}
    `.trim(),
  },
  variable5: {
    instrumented: `
s.set('x', <1-5>);
s.set('x', s.get('x') - 1);
s.set('y', s.get('x') * 2);
s.set('y', s.get('y') / 3);
const t = new Turtle(s.get('x') + 1, s.get('y') + 1); // trace
t.forward();
`.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        int x = <1-5>; // sid
        x--; // sid
        int y = x * 2; // sid
        y /= 3; // sid
        Turtle 亀 = new Turtle(x + 1, y + 1); // sid
        亀.前に進む(); // sid
    }
}
    `.trim(),
  },
  variable6: {
    instrumented: `
s.set('a', <1-3>);
s.set('b', s.get('a') * 2);
s.set('c', s.get('b') - 2);
const t = new Turtle(s.get('c'), s.get('b')); // trace
t.forward();
`.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        int a = <1-3>; // sid
        int b = a * 2; // sid
        int c = b - 2; // sid
        Turtle 亀 = new Turtle(c, b); // sid
        亀.前に進む(); // sid
    }
}
    `.trim(),
  },
  variable7: {
    instrumented: `
s.set('x', <0-2>);
s.set('y', (s.get('x') * 2) + 1);
s.set('z', (s.get('y') * 2) + (s.get('x') / 2));
s.set('x', s.get('z') / 3);
const t = new Turtle(s.get('x'), s.get('y')); // trace
t.forward();
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        int x = <0-2>; // sid
        int y = (x * 2) + 1; // sid
        int z = (y * 2) + (x / 2); // sid
        x = z / 3; // sid
        Turtle 亀 = new Turtle(x, y); // sid
        亀.前に進む(); // sid
    }
}
    `.trim(),
  },
  variable8: {
    instrumented: `
s.set('x', <0-2>);
s.set('y', (s.get('x') * 3) + 2);
s.set('z', (s.get('y') * 2) - (s.get('x') * 3));
s.set('x', (s.get('z') / 4) % 7);
s.set('y', (s.get('x') + s.get('y')) % 7);
const t = new Turtle(s.get('x'), s.get('y')); // trace
t.backward();
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        int x = <0-2>; // sid
        int y = (x * 3) + 2; // sid
        int z = (y * 2) - (x * 3); // sid
        x = (z / 4) % 7; // sid
        y = (x + y) % 7; // sid
        Turtle 亀 = new Turtle(x, y); // sid
        亀.後に戻る(); // sid
    }
}
    `.trim(),
  },
  variable9: {
    instrumented: `
s.set('x', <0-3>);
s.set('y', (s.get('x') * 4) + 3);
s.set('z', (s.get('y') * 3) - (s.get('x') * 2));
s.set('x', ((s.get('z') / 5) + s.get('x')) % 7);
s.set('y', ((s.get('x') * 2) + s.get('y')) % 7);
const t = new Turtle(s.get('x'), s.get('y')); // trace
t.forward();
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        int x = <0-3>; // sid
        int y = (x * 4) + 3; // sid
        int z = (y * 3) - (x * 2); // sid
        x = ((z / 5) + x) % 7; // sid
        y = ((x * 2) + y) % 7; // sid
        Turtle 亀 = new Turtle(x, y); // sid
        亀.前に進む(); // sid
    }
}
    `.trim(),
  },
  variable10: {
    instrumented: `
s.set('x', <0-3>);
s.set('y', (s.get('x') * 5) + 4);
s.set('z', (s.get('y') * 2) - (s.get('x') * 3));
s.set('w', (s.get('z') + s.get('x')) % 5);
s.set('x', ((s.get('z') / 6) + s.get('w')) % 7);
s.set('y', ((s.get('x') * 3) + s.get('y')) % 7);
const t = new Turtle(s.get('x'), s.get('y')); // trace
t.forward();
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        int x = <0-3>; // sid
        int y = (x * 5) + 4; // sid
        int z = (y * 2) - (x * 3); // sid
        int w = (z + x) % 5; // sid
        x = ((z / 6) + w) % 7; // sid
        y = ((x * 3) + y) % 7; // sid
        Turtle 亀 = new Turtle(x, y); // sid
        亀.前に進む(); // sid
    }
}
    `.trim(),
  },
  while1: {
    instrumented: `
const t = new Turtle(); // trace
s.set('i', 0);
while (s.get('i') < <3-5>) {
  t.forward();
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
const t = new Turtle(<0-1>, <0-1>); // trace
s.set('i', <1-2>);
while (s.get('i') < <4-6>) {
  t.forward();
  s.set('i', s.get('i') + 1);
}
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(<0-1>, <0-1>); // sid
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
const t = new Turtle(); // trace
s.set('i', 0);
while (s.get('i') < <2-3>) {
  s.set('i', s.get('i') + 1);
  t.forward();
  t.turnRight();
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
const t = new Turtle(<0-1>, <0-1>); // trace
t.turnRight();
s.set('i', <1-2>);
while (s.get('i') < <4-5>) {
  t.forward();
  t.forward();
  t.turnLeft();
  s.set('i', s.get('i') + 1);
}
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(<0-1>, <0-1>); // sid
        亀.右を向く(); // sid
        int i = <1-2>; // sid
        while (i < <4-5>) {
            亀.前に進む(); // sid
            亀.前に進む(); // sid
            亀.左を向く(); // sid
            i++; // sid
        }
    }
}
    `.trim(),
  },
  while5: {
    instrumented: `
const t = new Turtle(); // trace
s.set('i', <1-2>);
while (s.get('i') < <3-4>) {
  t.forward();
  t.turnRight();
  t.forward();
  t.turnLeft();
  s.set('i', s.get('i') + 1);
}
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(); // sid
        int i = <1-2>; // sid
        while (i < <3-4>) {
            亀.前に進む(); // sid
            亀.右を向く(); // sid
            亀.前に進む(); // sid
            亀.左を向く(); // sid
            i++; // sid
        }
    }
}
    `.trim(),
  },
  for1: {
    instrumented: `
const t = new Turtle(); // trace
for (s.set('i', 0); s.get('i') < <3-5>; s.set('i', s.get('i') + 1)) {
  t.forward();
}
delete s.vars['i'];
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
const t = new Turtle(<1-2>, <1-2>); // trace
for (s.set('i', <1-2>); s.get('i') < <4-6>; s.set('i', s.get('i') + 1)) {
  t.forward();
}
delete s.vars['i'];
       `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(<1-2>, <1-2>); // sid
        for (int i = <1-2>; i < <4-6>; i++) { // sid
            亀.前に進む(); // sid
        }
    }
}
    `.trim(),
  },
  for3: {
    instrumented: `
const t = new Turtle(); // trace
s.set('i', 0);
for (; s.get('i') < <2-3>;) {
  t.forward();
  t.turnRight();
  s.set('i', s.get('i') + 1);
}
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(); // sid
        int i = 0; // sid
        for (; i < <2-3>;) {
            亀.前に進む(); // sid
            亀.右を向く(); // sid
            i++; // sid
        }
    }
}
    `.trim(),
  },
  for4: {
    instrumented: `
const t = new Turtle(<1-2>, <1-2>); // trace
s.set('i', 1);
for (; s.get('i') < <3-4>;) {
  t.forward();
  t.turnRight();
  s.set('i', s.get('i') + 1);
}
t.backward();
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(<1-2>, <1-2>); // sid
        int i = 1; // sid
        for (; i < <3-4>;) {
            亀.前に進む(); // sid
            亀.右を向く(); // sid
            i++; // sid
        }
        亀.後に戻る(); // sid
    }
}
    `.trim(),
  },
  for5: {
    instrumented: `
s.set('x', 0);
for (s.set('i', 2); s.get('i') <= <4-5>; s.set('i', s.get('i') + 1)) {
  s.set('x', s.get('x') + s.get('i'));
}
delete s.vars['i'];
s.set('x', s.get('x') / 3);
const t = new Turtle(s.get('x') + 1, 0); // trace
t.forward();
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        int x = 0; // sid
        for (int i = 2; i <= <4-5>; i++) { // sid
            x += i; // sid
        }
        x /= 3; // sid
        Turtle 亀 = new Turtle(x + 1, 0); // sid
        亀.前に進む(); // sid
    }
}
    `.trim(),
  },
  for6: {
    instrumented: `
s.set('a', 0);
s.set('b', 100);
for (s.set('i', <4-5>); s.get('i') > 0; s.set('i', s.get('i') - 1)) {
  s.set('a', s.get('a') + s.get('i'));
  s.set('b', s.get('b') - s.get('i'));
}
delete s.vars['i'];
s.set('a', s.get('a') / 4);
s.set('b', s.get('b') / 5);
const t = new Turtle(s.get('a') % 6, s.get('b') % 6); // trace
t.forward();
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        int a = 0; // sid
        int b = 100; // sid
        for (int i = <4-5>; i > 0; i--) { // sid
            a += i; // sid
            b -= i; // sid
        }
        a /= 4; // sid
        b /= 5; // sid
        Turtle 亀 = new Turtle(a % 6, b % 6); // sid
        亀.前に進む(); // sid
    }
}
    `.trim(),
  },
  for7: {
    instrumented: `
const t = new Turtle(3, 3); // trace
s.set('sum', 0);
for (s.set('i', 1); s.get('i') <= <4-6>; s.set('i', s.get('i') + 1)) {
  s.set('sum', s.get('sum') + s.get('i'));
  t.forward();
  t.turnLeft();
}
delete s.vars['i'];
for (s.set('i', s.get('sum') / 4); s.get('i') >= 0; s.set('i', s.get('i') - 1)) {
  t.forward();
  t.forward();
  t.turnRight();
}
delete s.vars['i'];
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(3, 3); // sid
        int sum = 0; // sid
        for (int i = 1; i <= <4-6>; i++) { // sid
            sum += i; // sid
            亀.前に進む(); // sid
            亀.左を向く(); // sid
        }
        for (int i = sum / 4; i >= 0; i--) { // sid
            亀.前に進む(); // sid
            亀.前に進む(); // sid
            亀.右を向く(); // sid
        }
    }
}
    `.trim(),
  },
  doubleLoop1: {
    instrumented: `
const t = new Turtle(); // trace
for (s.set('i', 0); s.get('i') < <2-3>; s.set('i', s.get('i') + 1)) {
  for (s.set('j', 0); s.get('j') < <2-3>; s.set('j', s.get('j') + 1)) {
      t.forward();
  }
  delete s.vars['j'];
  t.turnRight();
}
delete s.vars['i'];
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
const t = new Turtle(); // trace
t.turnRight();
for (s.set('i', 0); s.get('i') < <2-3>; s.set('i', s.get('i') + 1)) {
  for (s.set('j', 0); s.get('j') < <2-3>; s.set('j', s.get('j') + 1)) {
      t.forward();
  }
  delete s.vars['j'];
  t.turnLeft();
}
delete s.vars['i'];
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid
        t.右を向く(); // sid
        for (int i = 0; i < <2-3>; i++) { // sid
            for (int j = 0; j < <2-3>; j++) { // sid
                t.前に進む(); // sid
            }
            t.左を向く(); // sid
        }
    }
}
    `.trim(),
  },
  doubleLoop3: {
    instrumented: `
const t = new Turtle(); // trace
for (s.set('i', <3-4>); s.get('i') > 0; s.set('i', s.get('i') - 1)) {
  for (s.set('j', 0); s.get('j') < s.get('i'); s.set('j', s.get('j') + 1)) {
    t.forward();
  }
  delete s.vars['j'];
  t.turnRight();
}
delete s.vars['i'];
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
  doubleLoop4: {
    instrumented: `
const t = new Turtle(); // trace
for (s.set('i', <3-4>); s.get('i') > 0; s.set('i', s.get('i') - 1)) {
  s.set('j', s.get('i'));
  while (s.get('j') >= 0) {
    t.forward();
    s.set('j', s.get('j') - 1);
  }
  t.turnRight();
  delete s.vars['j'];
}
delete s.vars['i'];
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid
        for (int i = 3; i > 0; i--) { // sid
            int j = i; // sid
            while (j >= 0) {
                t.前に進む(); // sid
                j--; // sid
            }
            t.右を向く(); // sid
        }
    }
}
    `.trim(),
  },
  doubleLoop5: {
    instrumented: `
const t = new Turtle(); // trace
for (s.set('i', 0); s.get('i') < <3-4>; s.set('i', s.get('i') + 1)) {
  for (s.set('j', <0-1>); s.get('j') <= s.get('i'); s.set('j', s.get('j') + 1)) {
    t.forward();
  }
  delete s.vars['j'];
  t.turnRight();
  for (s.set('k', <0-1>); s.get('k') < s.get('i'); s.set('k', s.get('k') + 1)) {
    t.forward();
  }
  delete s.vars['k'];
  t.turnLeft();
}
delete s.vars['i'];
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid
        for (int i = 0; i < <3-4>; i++) { // sid
            for (int j = <0-1>; j <= i; j++) { // sid
                t.前に進む(); // sid
            }
            t.右を向く(); // sid
            for (int k = <0-1>; k < i; k++) { // sid
                t.前に進む(); // sid
            }
            t.左を向く(); // sid
        }
    }
}
    `.trim(),
  },
  if1: {
    instrumented: `
const t = new Turtle(); // trace
for (s.set('i', 0); s.get('i') < <7-9>; s.set('i', s.get('i') + 1)) {
  t.forward();
  if (s.get('i') % 3 === 2) {
    t.turnRight();
  }
}
delete s.vars['i'];
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
const t = new Turtle(<1-2>, <1-2>); // trace
t.turnRight();
for (s.set('i', 0); s.get('i') < <6-8>; s.set('i', s.get('i') + 1)) {
  t.forward();
  if (s.get('i') % 3 === 1) {
    t.turnLeft();
  }
}
delete s.vars['i'];
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(<1-2>, <1-2>); // sid
        t.右を向く(); // sid
        for (int i = 0; i < <7-9>; i++) { // sid
            t.前に進む(); // sid
            if (i % 3 == 1) {
                t.左を向く(); // sid
            }
        }
    }
}
    `.trim(),
  },
  if3: {
    instrumented: `
const t = new Turtle(); // trace
for (s.set('i', 0); s.get('i') < <4-5>; s.set('i', s.get('i') + 1)) {
  t.forward();
  if (s.get('i') % 2 === 0) {
    t.turnRight();
  } else {
    t.turnLeft();
  }
}
delete s.vars['i'];
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid
        for (int i = 0; i < <4-5>; i++) { // sid
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
  if4: {
    instrumented: `
const t = new Turtle(); // trace
for (s.set('i', 0); s.get('i') < <4-5>; s.set('i', s.get('i') + 1)) {
  t.forward();
  if (s.get('i') % 3 === 0) {
    t.turnRight();
  } else {
    t.turnLeft();
  }
}
delete s.vars['i'];
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid
        for (int i = 0; i < <4-5>; i++) { // sid
            t.前に進む(); // sid
            if (i % 3 == 0) {
                t.右を向く(); // sid
            } else {
                t.左を向く(); // sid
            }
        }
    }
}
    `.trim(),
  },
  if5: {
    instrumented: `
const t = new Turtle(); // trace
for (s.set('i', 0); s.get('i') < <3-4>; s.set('i', s.get('i') + 1)) {
  for (s.set('j', 0); s.get('j') < <2-3>; s.set('j', s.get('j') + 1)) {
    if (s.get('j') % 2 === 0) {
      t.forward();
    } else {
      t.turnRight();
    }
  }
  delete s.vars['j'];
  t.forward();
  t.turnLeft();
}
delete s.vars['i'];
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid
        for (int i = 0; i < <3-4>; i++) { // sid
            for (int j = 0; j < <2-3>; j++) { // sid
                if (j % 2 == 0) {
                    t.前に進む(); // sid
                } else {
                    t.右を向く(); // sid
                }
            }
            t.前に進む(); // sid
            t.左を向く(); // sid
        }
    }
}
    `.trim(),
  },
  elseIf1: {
    instrumented: `
const t = new Turtle(); // trace
for (s.set('i', 0); s.get('i') < <4-6>; s.set('i', s.get('i') + 1)) {
  if (s.get('i') < 2) {
    t.forward();
  } else if (s.get('i') === 2) {
    t.turnLeft();
  } else {
    t.backward();
  }
}
delete s.vars['i'];
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid
        for (int i = 0; i < <4-6>; i++) { // sid
            if (i < 2)
                t.前に進む(); // sid
            else if (i == 2)
                t.左を向く(); // sid
            else
                t.後に戻る(); // sid
        }
    }
}
    `.trim(),
  },
  elseIf2: {
    instrumented: `
const t = new Turtle(); // trace
for (s.set('i', 0); s.get('i') < <5-7>; s.set('i', s.get('i') + 1)) {
  if (s.get('i') % 4 === 0) {
    t.forward();
  } else if (s.get('i') % 4 === 1) {
    t.turnRight();
  } else if (s.get('i') % 4 === 2) {
    t.forward();
  } else {
    t.turnLeft();
  }
}
delete s.vars['i'];
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid
        for (int i = 0; i < <5-7>; i++) { // sid
            if (i % 4 == 0)
                t.前に進む(); // sid
            else if (i % 4 == 1)
                t.右を向く(); // sid
            else if (i % 4 == 2)
                t.前に進む(); // sid
            else
                t.左を向く(); // sid
        }
    }
}
    `.trim(),
  },
  elseIf3: {
    instrumented: `
const t = new Turtle(); // trace
for (s.set('i', 0); s.get('i') < 7; s.set('i', s.get('i') + 1)) {
  if (s.get('i') < 2) {
    t.forward();
  } else if (s.get('i') === 2) {
    t.turnLeft();
  } else if (s.get('i') === <4-5>) {
    t.turnRight();
  } else {
    t.backward();
  }
}
delete s.vars['i'];
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid
        for (int i = 0; i < 7; i++) { // sid
            if (i < 2)
                t.前に進む(); // sid
            else if (i == 2)
                t.左を向く(); // sid
            else if (i == <4-5>)
                t.右を向く(); // sid
            else
                t.後に戻る(); // sid
        }
    }
}
    `.trim(),
  },
  elseIf4: {
    instrumented: `
const t = new Turtle(); // trace
for (s.set('i', 0); s.get('i') < <6-7>; s.set('i', s.get('i') + 1)) {
  if (s.get('i') % 5 === 0) {
    t.forward();
  } else if (s.get('i') % 5 === 1) {
    t.turnLeft();
  } else if (s.get('i') % 5 === 2) {
    t.backward();
  } else {
    t.turnRight();
  }
}
delete s.vars['i'];
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid
        for (int i = 0; i < <6-7>; i++) { // sid
            if (i % 5 == 0)
                t.前に進む(); // sid
            else if (i % 5 == 1)
                t.左を向く(); // sid
            else if (i % 5 == 2)
                t.後に戻る(); // sid
            else
                t.右を向く(); // sid
        }
    }
}
    `.trim(),
  },
  elseIf5: {
    instrumented: `
const t = new Turtle(); // trace
for (s.set('i', 0); s.get('i') < <7-8>; s.set('i', s.get('i') + 1)) {
  if (s.get('i') % 5 === 1) {
    t.turnRight();
  } else if (s.get('i') % 5 === 3) {
    t.turnLeft();
  } else {
    t.forward();
  }
}
delete s.vars['i'];
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid
        for (int i = 0; i < <7-8>; i++) { // sid
            if (i % 5 == 1)
                t.右を向く(); // sid
            else if (i % 5 == 3)
                t.左を向く(); // sid
            else
                t.前に進む(); // sid
        }
    }
}
    `.trim(),
  },
  switch1: {
    instrumented: `
const t = new Turtle(); // trace
for (s.set('i', 0); s.get('i') < <5-7>; s.set('i', s.get('i') + 1)) {
  switch (s.get('i')) {
    case 0: case 1:
      t.forward(); break;
    case 2:
      t.turnLeft(); break;
    default:
      t.backward(); break;
  }
}
delete s.vars['i'];
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
const t = new Turtle(); // trace
for (s.set('i', 0); s.get('i') < <5-7>; s.set('i', s.get('i') + 1)) {
  switch (s.get('i') % 4) {
    case 1:
      t.turnRight(); break;
    case 3:
      t.turnLeft(); break;
    default:
      t.forward(); break;
  }
}
delete s.vars['i'];
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
  switch3: {
    instrumented: `
const t = new Turtle(2, 2); // trace
for (s.set('i', 0); s.get('i') < <6-7>; s.set('i', s.get('i') + 1)) {
  switch (s.get('i')) {
    case 0:
    case 1:
      t.forward();
      break;
    case 2:
      t.turnLeft();
      break;
    case 4:
    case 5:
      t.turnRight();
      break;
    default:
      t.backward();
  }
}
delete s.vars['i'];
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // sid
        for (int i = 0; i < <6-7>; i++) { // sid
            switch (i) {
                case 0:
                case 1:
                    t.前に進む(); // sid
                    break;
                case 2:
                    t.左を向く(); // sid
                    break;
                case 4:
                case 5:
                    t.右を向く(); // sid
                    break;
                default:
                    t.後に戻る(); // sid
            }
        }
    }
}
    `.trim(),
  },
  switch4: {
    instrumented: `
const t = new Turtle(); // trace
for (s.set('i', 0); s.get('i') < <7-8>; s.set('i', s.get('i') + 1)) {
  switch (s.get('i') % 5) {
    case 0:
      t.turnLeft();
      break;
    case 1:
      t.backward();
      break;
    case 2:
      t.turnRight();
      break;
    default:
      t.forward();
  }
}
delete s.vars['i'];
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid
        for (int i = 0; i < <7-8>; i++) { // sid
            switch (i % 5) {
                case 0:
                    t.左を向く(); // sid
                    break;
                case 1:
                    t.後に戻る(); // sid
                    break;
                case 2:
                    t.右を向く(); // sid
                    break;
                default:
                    t.前に進む(); // sid
            }
        }
    }
}
    `.trim(),
  },
  switch5: {
    instrumented: `
const t = new Turtle(); // trace
for (s.set('i', 0); s.get('i') < <9-10>; s.set('i', s.get('i') + 1)) {
  switch (s.get('i') % 6) {
    case 0:
      t.turnLeft();
      break;
    case 1:
    case 2:
      t.backward();
      break;
    case 3:
      t.turnRight();
      break;
    default:
      t.forward();
  }
}
delete s.vars['i'];
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid
        for (int i = 0; i < <9-10>; i++) { // sid
            switch (i % 6) {
                case 0:
                    t.左を向く(); // sid
                    break;
                case 1:
                case 2:
                    t.後に戻る(); // sid
                    break;
                case 3:
                    t.右を向く(); // sid
                    break;
                default:
                    t.前に進む(); // sid
            }
        }
    }
}
    `.trim(),
  },
  break1: {
    instrumented: `
const t = new Turtle(); // trace
while (true) {
  if (!t.canMoveForward()) break;
  t.forward();
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
const t = new Turtle(<3-4>,<3-4>); // trace
while (true) {
  if (!t.canMoveForward()) break;
  t.forward();
  t.turnRight();

  if (!t.canMoveForward()) break;
  t.forward();
  t.turnLeft();
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
const t = new Turtle(<4-6>, <4-6>); // trace
for (s.set('i', 0); s.get('i') < 4; s.set('i', s.get('i') + 1)) {
  while (true) {
    t.forward();
    if (!t.canMoveForward()) break;
  }
  t.turnRight();
}
delete s.vars['i'];
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
  break4: {
    instrumented: `
const t = new Turtle(<3-5>, <3-5>); // trace
for (s.set('i', 0); s.get('i') < 3; s.set('i', s.get('i') + 1)) {
  while (true) {
    if (!t.canMoveForward()) break;
    t.forward();
  }
  t.turnLeft();
}
delete s.vars['i'];
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(<3-5>, <3-5>); // sid
        for (int i = 0; i < 3; i++) { // sid
            while (true) {
                if (!t.前に進めるか()) break;
                t.前に進む(); // sid
            }
            t.左を向く(); // sid
        }
    }
}
    `.trim(),
  },
  break5: {
    instrumented: `
const t = new Turtle(<4-6>, <4-6>); // trace
for (s.set('i', 0); s.get('i') < 3; s.set('i', s.get('i') + 1)) {
  for (s.set('j', 0); s.get('j') < 6; s.set('j', s.get('j') + 1)) {
    if (!t.canMoveForward()) break;
    t.forward();
    if (s.get('j') % 3 === 0) {
      t.turnLeft();
    } else {
      t.turnRight();
    }
  }
  delete s.vars['j'];
  t.turnRight();
}
delete s.vars['i'];
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(<4-6>, <4-6>); // sid
        for (int i = 0; i < 3; i++) { // sid
            for (int j = 0; j < 6; j++) { // sid
                if (!t.前に進めるか()) break;
                t.前に進む(); // sid
                if (j % 3 == 0) {
                    t.左を向く(); // sid
                } else {
                    t.右を向く(); // sid
                }
            }
            t.右を向く(); // sid
        }
    }
}
    `.trim(),
  },
  continue1: {
    instrumented: `
const t = new Turtle(); // trace
for (s.set('i', 0); s.get('i') < <3-5>; s.set('i', s.get('i') + 1)) {
  if (s.get('i') == 0) {
    continue;
  }
  t.forward();
}
delete s.vars['i'];
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
const t = new Turtle(); // trace
for (s.set('i', 0); s.get('i') < <5-7>; s.set('i', s.get('i') + 1)) {
  if (s.get('i') % <2-3> == 1) {
    t.turnRight();
    continue;
  }
  t.forward();
}
delete s.vars['i'];
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
const t = new Turtle(); // trace
for (s.set('i', 0); s.get('i') < 2; s.set('i', s.get('i') + 1)) {
  for (s.set('j', s.get('i') * 4); s.get('j') < 8; s.set('j', s.get('j') + 1)) {
    if (s.get('j') % 4 == 1) {
      t.turnRight(); continue;
    } else if (s.get('j') % 4 == 3) {
      t.turnLeft(); continue;
    }
    t.forward();
  }
  delete s.vars['j'];
  t.turnLeft();
}
delete s.vars['i'];
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
  continue4: {
    instrumented: `
const t = new Turtle(); // trace
for (s.set('i', 0); s.get('i') < 3; s.set('i', s.get('i') + 1)) {
  for (s.set('j', s.get('i')); s.get('j') < 6; s.set('j', s.get('j') + 1)) {
    if (s.get('j') % 2 == 0) {
      t.turnRight(); continue;
    }
    if (t.canMoveForward()) {
      t.forward();
    }
  }
  delete s.vars['j'];
  t.turnLeft();
}
delete s.vars['i'];
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid
        for (int i = 0; i < 3; i++) { // sid
            for (int j = i; j < 6; j++) { // sid
                if (j % 2 == 0) {
                    t.右を向く(); continue; // sid
                }
                if (t.前に進めるか()) {
                    t.前に進む(); // sid
                }
            }
            t.左を向く(); // sid
        }
    }
}
    `.trim(),
  },
  continue5: {
    instrumented: `
const t = new Turtle(); // trace
for (s.set('i', 0); s.get('i') < 3; s.set('i', s.get('i') + 1)) {
  for (s.set('j', s.get('i') + 1); s.get('j') < 6; s.set('j', s.get('j') + 1)) {
    if (s.get('j') % 4 == 0) {
      t.turnLeft(); continue;
    } else if (s.get('j') % 3 == 2) {
      t.turnRight(); continue;
    }
    if (t.canMoveForward()) {
      t.forward();
    }
  }
  delete s.vars['j'];
}
delete s.vars['i'];
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid
        for (int i = 0; i < 3; i++) { // sid
            for (int j = i + 1; j < 6; j++) { // sid
                if (j % 4 == 0) {
                    t.左を向く(); continue; // sid
                } else if (j % 3 == 2) {
                    t.右を向く(); continue; // sid
                }
                if (t.前に進めるか()) {
                    t.前に進む(); // sid
                }
            }
        }
    }
}
    `.trim(),
  },
  method1: {
    instrumented: `
const t = new Turtle(); // trace
call(forwardTwoSteps, 't')(t);
t.turnRight();
call(threeStepsForward, 't')(t);

function forwardTwoSteps(t) {
  t.forward();
  t.forward();
}

function threeStepsForward(t) {
  t.forward();
  t.forward();
  t.forward();
}
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid: 1
        二歩前に進める(t); // caller
        t.右を向く(); // sid: 2
        三歩前に進める(t); // caller
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
const t = new Turtle(); // trace
call(forwardTwoSteps, 't')(t);
call(turnAround, 't')(t);
t.forward();

function forwardTwoSteps(t) {
  t.forward();
  t.forward();
}

function turnAround(t) {
  t.turnRight();
  t.turnRight();
}

    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid
        二歩前に進める(t); // caller
        後ろを向く(t); // caller
        t.前に進む(); // sid
    }
    static void 二歩前に進める(Turtle t) {
        t.前に進む(); // sid
        t.前に進む(); // sid
    }
    static void 後ろを向く(Turtle t) {
        t.右を向く(); // sid
        t.右を向く(); // sid
    }
}
    `.trim(),
  },
  method3: {
    instrumented: `
const t = new Turtle(); // trace
call(forwardGivenSteps, 't', 'n')(t, <3-4>);
t.turnRight();
call(forwardGivenSteps, 't', 'n')(t, 2);

function forwardGivenSteps(t, n) {
  for (s.set('i', 0); s.get('i') < n; s.set('i', s.get('i') + 1)) {
    t.forward();
  }
  delete s.vars['i'];
}
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid
        N歩前に進める(t, <3-4>); // caller
        t.右を向く(); // sid
        N歩前に進める(t, 2); // caller
    }

    static void N歩前に進める(Turtle t, int n) {
        for (int i = 0; i < n; i++) { // sid
            t.前に進む(); // sid
        }
    }
}
    `.trim(),
  },
  method4: {
    instrumented: `
const t = new Turtle(); // trace
call(forwardTwoSteps, 't')(t);
t.turnRight();
call(forwardFourSteps, 't')(t);

function forwardTwoSteps(t) {
  t.forward();
  t.forward();
}

function forwardFourSteps(t) {
  call(forwardTwoSteps, 't')(t);
  call(forwardTwoSteps, 't')(t);
}
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid
        二歩前に進める(t); // caller
        t.右を向く(); // sid
        四歩前に進める(t); // caller
    }
    static void 二歩前に進める(Turtle t) {
        t.前に進む(); // sid
        t.前に進む(); // sid
    }
    static void 四歩前に進める(Turtle t) {
        二歩前に進める(t); // caller
        二歩前に進める(t); // caller
    }
}
    `.trim(),
  },
  method5: {
    instrumented: `
const t = new Turtle(); // trace
call(drawSquare, 't')(t);
t.backward();
t.backward();
call(drawSquare, 't')(t);

function drawSquare(t) {
  for (s.set('i', 0); s.get('i') < 3; s.set('i', s.get('i') + 1)) {
    t.forward();
    t.turnRight();
  }
  delete s.vars['i'];
}
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid
        正方形を描く(t); // caller
        t.後に戻る(); // sid
        t.後に戻る(); // sid
        正方形を描く(t); // caller
    }
    static void 正方形を描く(Turtle t) {
        for (int i = 0; i < 3; i++) { // sid
            t.前に進む(); // sid
            t.右を向く(); // sid
        }
    }
}
    `.trim(),
  },
  return1: {
    instrumented: `
const t = new Turtle(); // trace
s.set('x', call(double, 'a')(<2-3>));
call(forwardGivenSteps, 't', 'n')(t, s.get('x'));

function forwardGivenSteps(t, n) {
  for (s.set('i', 0); s.get('i') < n; s.set('i', s.get('i') + 1)) {
    t.forward();
  }
  delete s.vars['i'];
}

function double(a) {
  return a * 2;
}
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid
        int x = 二倍する(<2-3>); // sid // caller
        N歩前に進める(t, x); // caller
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
const t = new Turtle(); // trace
s.set('x', call(double, 'a')(2));
call(forwardGivenSteps, 't', 'n')(t, s.get('x'));
t.turnRight();
s.set('x', call(double, 'a')(s.get('x') - 1));
call(forwardGivenSteps, 't', 'n')(t, s.get('x'));

function forwardGivenSteps(t, n) {
  for (s.set('i', 0); s.get('i') < n; s.set('i', s.get('i') + 1)) {
    t.forward();
  }
  delete s.vars['i'];
}

function double(a) {
  return a * 2;
}
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid
        int x = 二倍する(2); // sid // caller
        N歩前に進める(t, x); // caller
        t.右を向く(); // sid
        x = 二倍する(x - 1); // sid // caller
        N歩前に進める(t, x); // caller
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
  return3: {
    instrumented: `
const t = new Turtle(); // trace
call(forwardGivenSteps, 't', 'n')(t, call(add, 'a', 'b')(1, 1));
call(forwardGivenSteps, 't', 'n')(t, call(add, 'a', 'b')(1, 2));

function forwardGivenSteps(t, n) {
  for (s.set('i', 0); s.get('i') < n; s.set('i', s.get('i') + 1)) {
    t.forward();
  }
  delete s.vars['i'];
}

function add(a, b) {
  return a + b;
}
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid
        N歩前に進める(t, 加算する(1, 1)); // caller
        N歩前に進める(t, 加算する(1, 2)); // caller
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
  return4: {
    instrumented: `
const t = new Turtle(); // trace
for (s.set('i', 0); s.get('i') < <3-4>; s.set('i', s.get('i') + 1)) {
  if (call(isEven, 'a')(s.get('i'))) {
    t.turnRight();
    call(forwardTwoSteps, 't')(t);
  }
  else {
    call(forwardTwoSteps, 't')(t);
    t.turnRight();
    t.turnRight();
  }
}
delete s.vars['i'];

function forwardTwoSteps(t) {
  t.forward();
  t.forward();
}

function isEven(a) {
  return a % 2 === 0;
}

    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid
        for (int i = 0; i < <3-4>; i++) { // sid
            if (偶数か(i)) { // caller
                t.右を向く(); // sid
                二歩前に進める(t); // caller
            } else {
                二歩前に進める(t); // caller
                t.右を向く(); // sid
                t.右を向く(); // sid
            }
        }
    }
    static void 二歩前に進める(Turtle t) {
        t.前に進む(); // sid
        t.前に進む(); // sid
    }
    static boolean 偶数か(int a) {
        return a % 2 == 0;
    }
}
    `.trim(),
  },
  return5: {
    instrumented: `
const t = new Turtle(); // trace
for (s.set('i', 0); s.get('i') < 3; s.set('i', s.get('i') + 1)) {
  for (s.set('j', 0); s.get('j') < 3; s.set('j', s.get('j') + 1)) {
    if (call(isEqual, 'a', 'b')(s.get('i'), s.get('j')))
      t.turnRight();
    else
      call(forwardTwoSteps, 't')(t);
  }
  delete s.vars['j'];
  t.turnLeft();
}
delete s.vars['i'];

function forwardTwoSteps(t) {
  t.forward();
  t.forward();
}

function isEqual(a, b) {
  return a == b;
}
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid
        for (int i = 0; i < 3; i++) { // sid
            for (int j = 0; j < 3; j++) { // sid
                if (等しいか(i, j)) // caller
                    t.右を向く(); // sid
                else
                    二歩前に進める(t); // caller
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
const t = new Turtle(); // trace
s.set('arr', [2, <1-2>, <1-2>]);
for (s.set('i', 0); s.get('i') < s.get('arr').length; s.set('i', s.get('i') + 1)) {
  call(forwardGivenSteps, 't', 'n')(t, s.get('arr')[s.get('i')]);
  t.turnRight();
}
delete s.vars['i'];

function forwardGivenSteps(t, n) {
  for (s.set('i', 0); s.get('i') < n; s.set('i', s.get('i') + 1)) {
    t.forward();
  }
  delete s.vars['i'];
}
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid
        int[] arr = { 2, <1-2>, <1-2> }; // sid
        for (int i = 0; i < arr.length; i++) { // sid
            N歩前に進める(t, arr[i]); // caller
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
const t = new Turtle(); // trace
s.set('arr', [<4-5>, <3-4>, <3-4>]);
for (s.set('i', 0); s.get('i') < s.get('arr').length; s.set('i', s.get('i') + 1)) {
  call(forwardGivenSteps, 't', 'n')(t, s.get('arr')[s.get('i')]);
  t.turnRight();
}
delete s.vars['i'];

function forwardGivenSteps(t, n) {
  for (s.set('i', 0); s.get('i') < n; s.set('i', s.get('i') + 1)) {
    t.forward();
  }
  delete s.vars['i'];
}
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid
        int[] arr = { <4-5>, <3-4>, <3-4> }; // sid
        for (int i = 0; i < arr.length; i++) { // sid
            N歩前に進める(t, arr[i]); // caller
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
  array3: {
    instrumented: `
const t = new Turtle(); // trace
s.set('arr', [0, 1, 0, 2, 0]);
for (s.set('i', 0); s.get('i') < s.get('arr').length; s.set('i', s.get('i') + 1)) {
  switch (s.get('arr')[s.get('i')]) {
    case 0:
      t.forward(); break;
    case 1:
      t.turnRight(); break;
    case 2:
      t.turnLeft(); break;
  }
}
delete s.vars['i'];
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
  array4: {
    instrumented: `
const t = new Turtle(); // trace
s.set('arr', [0, 1, 0, 2, 0]);
for (const cmd of [0, 1, 0, 2, 0]) {
  s.set('cmd', cmd);
  switch (s.get('cmd')) {
    case 0:
      t.forward(); break;
    case 1:
      t.turnRight(); break;
    case 2:
      t.turnLeft(); break;
  }
}
delete s.vars['cmd'];
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
  array5: {
    instrumented: `
const t = new Turtle(); // trace
s.set('arr', [0, 1, 0, 2, 0, 3, 0]);
s.set('steps', 1);
for (const cmd of [0, 1, 0, 2, 0, 3, 0]) {
  s.set('cmd', cmd);
  switch (s.get('cmd')) {
    case 0:
      for (s.set('i', 0); s.get('i') < s.get('steps'); s.set('i', s.get('i') + 1)) {
        t.forward();
      }
      delete s.vars['i'];
      break;
    case 1:
      t.turnRight(); break;
    case 2:
      t.turnLeft(); break;
    case 3:
      s.set('steps', s.get('steps') + 1); break;
  }
}
delete s.vars['cmd'];
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid
        int[] arr = { 0, 1, 0, 2, 0, 3, 0 }; // sid
        int steps = 1; // sid
        for (int cmd : arr) { // sid
            switch (cmd) {
                case 0:
                    for (int i = 0; i < steps; i++) { // sid
                        t.前に進む(); // sid
                    }
                    break;
                case 1:
                    t.右を向く(); break; // sid
                case 2:
                    t.左を向く(); break; // sid
                case 3:
                    steps++; break; // sid
            }
        }
    }
}
    `.trim(),
  },
  string1: {
    instrumented: `
const t = new Turtle(); // trace
s.set('s', 'frflf');
for (s.set('i', 0); s.get('i') < s.get('s').length; s.set('i', s.get('i') + 1)) {
  switch (s.get('s').charAt(s.get('i'))) {
    case 'f':
      t.forward(); break;
    case 'r':
      t.turnRight(); break;
    case 'l':
      t.turnLeft(); break;
  }
}
delete s.vars['i'];
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
const t = new Turtle(); // trace
s.set('s', 'ffbrfl');
for (s.set('i', 0); s.get('i') < s.get('s').length; s.set('i', s.get('i') + 1)) {
  switch (s.get('s').charAt(s.get('i'))) {
    case 'f':
      t.forward(); break;
    case 'r':
      t.turnRight(); break;
    case 'l':
      t.turnLeft(); break;
    case 'b':
      t.backward(); break;
  }
}
delete s.vars['i'];
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid
        String s = "ffbrfl"; // sid
        for (int i = 0; i < s.length(); i++) { // sid
            switch (s.charAt(i)) {
                case 'f':
                    t.前に進む(); break; // sid
                case 'r':
                    t.右を向く(); break; // sid
                case 'l':
                    t.左を向く(); break; // sid
                case 'b':
                    t.後に戻る(); break; // sid
            }
        }
    }
}
    `.trim(),
  },
  string3: {
    instrumented: `
const t = new Turtle(); // trace
s.set('s', 'frflf');
for (const ch of 'frflf') {
  s.set('ch', ch);
  switch (s.get('ch')) {
    case 'f':
      t.forward(); break;
    case 'r':
      t.turnRight(); break;
    case 'l':
      t.turnLeft(); break;
  }
}
delete s.vars['ch'];
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
  string4: {
    instrumented: `
const t = new Turtle(); // trace
s.set('cmds', ['ri', 'aa', 'fo']);
for (const cmd of ['ri', 'aa', 'fo']) {
  s.set('cmd', cmd);
  t.forward();
  call(parse, 't', 'c')(t, s.get('cmd'));
}
delete s.vars['cmd'];

function parse(t, c) {
  if (c === 'fo') t.forward();
  else if (c === 'ri') t.turnRight();
}
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid
        String[] cmds = { "ri", "aa", "fo" }; // sid
        for (String cmd : cmds) { // sid
            t.前に進む(); // sid
            parse(t, cmd); // caller
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
  string5: {
    instrumented: `
const t = new Turtle(); // trace
s.set('cmds', ['ri', 'add', 'fo', 'add', 'le', 'fo', 'fo']);
s.set('x', 0);
for (const cmd of ['ri', 'add', 'fo', 'add', 'le', 'fo', 'fo']) {
  s.set('cmd', cmd);
  call(parse, 't', 'c', 'x')(t, s.get('cmd'), s.get('x'));
  if (cmd === 'add') {
    s.set('x', s.get('x') + 1);
  }
}
delete s.vars['cmd'];

function parse(t, c, x) {
  if (c === 'fo') call(forwardGivenSteps, 't', 'n')(t, x);
  else if (c === 'ri') t.turnRight();
  else if (c === 'le') t.turnLeft();
}

function forwardGivenSteps(t, n) {
  for (s.set('i', 0); s.get('i') < n; s.set('i', s.get('i') + 1)) {
    t.forward();
  }
  delete s.vars['i'];
}
    `.trim(),
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // sid
        String[] cmds = { "ri", "add", "fo", "add", "le", "fo", "fo" }; // sid
        int x = 0; // sid
        for (String cmd : cmds) { // sid
            parse(t, cmd, x); // caller
            if (cmd.equals("add")) {
                x++; // sid
            }
        }
    }
    static void parse(Turtle t, String c, int x) {
        if (c.equals("fo"))
            N歩前に進める(t, x); // caller
        else if (c.equals("ri"))
            t.右を向く(); // sid
        else if (c.equals("le"))
            t.左を向く(); // sid
    }
    static void N歩前に進める(Turtle t, int n) {
        for (int i = 0; i < n; i++) { // sid
            t.前に進む(); // sid
        }
    }
}
    `.trim(),
  },
  oop1: {
    instrumented: `
const t1 = new Turtle(1, 1); // trace
const t2 = new Turtle(3, 3); // trace
t1.forward();
t2.forward();
t1.forward();
t2.forward();
`.trim(),
    java: `
public class Main {
  public static void main(String[] args) {
    Turtle t1 = new Turtle(1, 1); // sid
    Turtle t2 = new Turtle(3, 3); // sid
    t1.前に進む(); // sid
    t2.前に進む(); // sid
    t1.前に進む(); // sid
    t2.前に進む(); // sid
  }
}
`.trim(),
  },
  oop2: {
    // 上のコードから下にあるクラスを参照するためには、main()関数を定義しないといけない。
    instrumented: `
function main() {
  const m = call(MyTurtle, 'x', 'y', 'speed')(0, 0, 2);
  call(m.forward.bind(m))();
}

class MyTurtle {
  constructor(x, y, speed) {
    this.speed = speed; // trace
    this.c = new Turtle(x, y); // trace
  }
  forward() {
    for (s.set('i', 0); s.get('i') < this.speed; s.set('i', s.get('i') + 1)) {
      this.c.forward();
    }
    delete s.vars['i'];
  }
}

main();
`.trim(),
    java: `
public class Main {
  public static void main(String[] args) {
    MyTurtle m = new MyTurtle(0, 0, 2); // caller
    m.forward(); // caller
  }
}

class MyTurtle {
  private int speed;
  private Turtle c;
  public MyTurtle(int x, int y, int speed) {
    this.speed = speed; // sid
    this.c = new Turtle(x, y); // sid
  }
  public void forward() {
    for (int i = 0; i < this.speed; i++) {
      this.c.前に進む(); // sid
    }
  }
}
`.trim(),
  },
  // ----------- 初級プログラミングⅡ 第1回 ここから -----------
  multiObject1: {
    instrumented: `
const t1 = new Turtle(1, 1); //trace
const t2 = new Turtle(3, 3); //trace
t1.forward();
t1.turnRight();
t2.forward();
t2.turnLeft();
`.trim(),
    java: `
public class Main {
  public static void main(String[] args) {
    Turtle t1 = new Turtle(1, 1); //sid
    Turtle t2 = new Turtle(3, 3); //sid
    t1.前に進む(); //sid
    t1.右を向く(); //sid
    t2.前に進む(); //sid
    t2.左を向く(); //sid
  }
}
`.trim(),
  },
  multiObject2: {
    instrumented: `
const t1 = new Turtle(1, 1); //trace
t1.forward();
t1.turnRight();
const t2 = new Turtle(3, 3); //trace
t2.forward();
t2.turnLeft();
t2.forward();
`.trim(),
    java: `
public class Main {
  public static void main(String[] args) {
    Turtle t1 = new Turtle(1, 1); //sid
    t1.前に進む(); //sid
    t1.右を向く(); //sid
    Turtle t2 = new Turtle(3, 3); //sid
    t2.前に進む(); //sid
    t2.左を向く(); //sid
    t2.前に進む(); //sid
  }
}
`.trim(),
  },
  garbageCollection1: {
    instrumented: `
let t1 = new Turtle(1, 1); // trace
t1.forward();
t1.turnRight();
let t2 = new Turtle(3, 3); // trace
t2.forward();
t2.remove();
t2 = t1;
t2.forward();
`.trim(),
    java: `
public class Main {
  public static void main(String[] args) {
    Turtle t1 = new Turtle(1, 1); //sid
    t1.前に進む(); //sid
    t1.右を向く(); //sid
    Turtle t2 = new Turtle(3, 3); //sid
    t2.前に進む(); //sid
    t2 = t1; //sid
    t2.前に進む(); //sid
  }
}
`.trim(),
  },
  // ----------- 初級プログラミングⅡ 第1回 ここまで -----------

  // ----------- 初級プログラミングⅡ 第2回 ここから -----------
  // ----------- 初級プログラミングⅡ 第2回 ここまで -----------

  // ----------- 初級プログラミングⅡ 第3回 ここから -----------
  // ----------- 初級プログラミングⅡ 第3回 ここまで -----------

  // ----------- 初級プログラミングⅡ 第4回 ここから -----------
  static2: {
    // グローバル変数を扱う際は、 `myGlobal` という名前のオブジェクトを使うこと。
    // 上のコードから下にあるクラスを参照するためには、main()関数を定義しないといけない。
    instrumented: `
myGlobal.Settings = { speed: 3 };

function main() {
  const t1 = call(MyTurtle)(); // trace
  call(t1.moveForward.bind(t1))();
  myGlobal.Settings.speed = 2; // trace
  const t2 = call(MyTurtle)(); // trace
  call(t1.moveForward.bind(t1))();
  call(t2.moveForward.bind(t2))();
}

class MyTurtle {
  constructor() {
    this.t = new Turtle();
  }
  moveForward() {
    for (s.set('i', 0); s.get('i') < myGlobal.Settings.speed; s.set('i', s.get('i') + 1)) {
      this.t.forward();
    }
    delete s.vars['i'];
  }
}

main();
`.trim(),
    java: `
public class Main {
  public static void main(String[] args) {
    MyTurtle t1 = new MyTurtle(); // caller // sid
    t1.moveForward(); // caller
    Settings.speed = 2; // sid
    MyTurtle t2 = new MyTurtle(); // caller // sid
    t1.moveForward(); // caller
    t2.moveForward(); // caller
  }
}

class Settings {
  static public int speed = 3;
}

class MyTurtle {
  private Turtle t = new Turtle();

  void moveForward(Turtle t) {
    for (int i = 0; i < Settings.speed; i++) { // sid
      t.前に進む(); // sid
    }
  }
}
`.trim(),
  },
  // ----------- 初級プログラミングⅡ 第4回 ここまで -----------

  // ----------- 初級プログラミングⅡ 第5回 ここから -----------
  polymorphism1: {
    instrumented: `
function main() {
  const ts = [call(MyTurtle, 'x', 'y')(0, 0), call(FastTurtle, 'p')(1)]; // trace
  for (s.set('i', 0); s.get('i') < ts.length; s.set('i', s.get('i') + 1)) {
    call(ts[s.get('i')].drawLine.bind(ts[s.get('i')]))();
  }
}

class MyTurtle {
  constructor(x, y) {
    this.t = new Turtle(x, y);
  }
  drawLine() {
    for (s.set('i', 0); s.get('i') < this.length(); s.set('i', s.get('i') + 1)) {
      this.t.forward();
    }
    delete s.vars['i'];
  }
  length() {
    return 2;
  }
}

class FastTurtle extends MyTurtle {
  constructor(p) {
    super(p, p);
  }
  length() {
    return 3;
  }
}

main();
`.trim(),
    java: `
public class Main {
  public static void main(String[] args) {
    MyTurtle[] ts = {
        new MyTurtle(0, 0), new FastTurtle(1) };  // caller // sid
    for (int i = 0; i < ts.length; i++) {
      ts[i].drawLine(); // caller
    }
  }
}

class MyTurtle {
  Turtle t;

  MyTurtle(int x, int y) {
    this.t = new Turtle(x, y);
  }
  void drawLine() {
    for (int i = 0; i < this.length(); i++) { // sid
      this.t.前に進む(); // sid
    }
  }
  int length() {
    return 2;
  }
}

class FastTurtle extends MyTurtle {
  FastTurtle(int p) {
    super(p, p);
  }
  @Override int length() {
    return 3;
  }
}
`.trim(),
  },
  // ----------- 初級プログラミングⅡ 第5回 ここまで -----------

  // ----------- 初級プログラミングⅡ 第6回 ここから -----------
  // ----------- 初級プログラミングⅡ 第6回 ここまで -----------

  // ----------- 初級プログラミングⅡ 第7回 ここから -----------
  // ----------- 初級プログラミングⅡ 第7回 ここまで -----------

  // ----------- 初級プログラミングⅡ 第8回 ここから -----------
  // ----------- 初級プログラミングⅡ 第8回 ここまで -----------
  test1: {
    instrumented: `
const t = new Turtle(); // trace
t.forward();
t.forward();
t.forward();
`.trim(),
    // sidがただの連番である場合、番号を省略できる。
    java: `
public class Main {
  public static void main(String[] args) {
    Turtle c = new Turtle(); // sid
    c.forward(); // sid
    c.forward(); // sid
    c.forward(); // sid
  }
}
`.trim(),
  },
  test2: {
    instrumented: `
const t = new Turtle(); // trace
for (s.set('i', 0); s.get('i') < 2; s.set('i', s.get('i') + 1)) {
  t.forward();
  t.forward();
  t.turnRight();
}
delete s.vars['i'];
`.trim(),
    java: `
public class Main {
  public static void main(String[] args) {
    Turtle c = new Turtle(); // sid
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
  s.set('a', call(f, 'x', 'y')(s.get('a'), s.get('b')));
}
s.set('c', s.get('a') * 2);

function f(x, y) {
  s.set('a', x * y);
  return s.get('a');
}
`,
    java: `
public class Main {
  public static void main(String[] args) {
    int a = 1; // sid: 1
    if (a > 0) {
      int b = 2; // sid: 2
      a = f(a, b); // sid: 3 // caller
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
const t1 = new Turtle(); // trace
t1.forward();
t1.turnRight();
s.set('i', 0);
t1.forward();

const t2 = new Turtle(2, 3, 'G'); // trace
t2.forward();
s.set('foo', 'あいうえお');
s.set('bar', <1-100>);
s.set('i', s.get('bar') + 1);
t2.forward();
t2.forward();
`.trim(),
    java: `
public class Main {
  public static void main(String[] args) {
    Turtle c1 = new Turtle(); // sid
    c1.forward(); // sid
    c1.turnRight(); // sid
    int i = 0; // sid
    c1.forward(); // sid

    Turtle c2 = new Turtle(2, 3, "green"); // sid
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
const t = new Turtle(); // trace
t.forward();
t.forward();
t.turnRight();
t.forward();
t.forward();
t.forward();
t.forward();
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
