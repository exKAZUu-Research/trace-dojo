export const languageIds = ['instrumented', 'java'] as const;
export type LanguageId = (typeof languageIds)[number];

export const courseIdToName = {
  tuBeginner1: '初級プログラミングⅠ',
  tuBeginner2: '初級プログラミングⅡ',
  test: '動作確認用',
} as const;
export type CourseId = keyof typeof courseIdToName;
export const courseIds = Object.keys(courseIdToName) as CourseId[];

export const problemIdToName = {
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
  // 初級プログラミングⅡ 第1回
  multiObject1: '複数のオブジェクトを使おう(1)',
  multiObject2: '複数のオブジェクトを使おう(2)',
  multiObject3: '複数のオブジェクトを使おう(3)',
  multiObject4: '複数のオブジェクトを使おう(4)',
  multiObject5: '複数のオブジェクトを使おう(5)',
  multiObject6: '複数のオブジェクトを使おう(6)',
  garbageCollection1: 'ガベージコレクション(1)',
  garbageCollection2: 'ガベージコレクション(2)',
  garbageCollection3: 'ガベージコレクション(3)',
  garbageCollection4: 'ガベージコレクション(4)',
  garbageCollection5: 'ガベージコレクション(5)',
  garbageCollection6: 'ガベージコレクション(6)',
  // 初級プログラミングⅡ 第2回
  makeClass1: 'クラスを作ろう(1)',
  makeClass2: 'クラスを作ろう(2)',
  makeClass3: 'クラスを作ろう(3)',
  makeClass4: 'クラスを作ろう(4)',
  makeClass5: 'クラスを作ろう(5)',
  makeClass6: 'クラスを作ろう(6)',
  constructor1: 'コンストラクタ(1)',
  constructor2: 'コンストラクタ(2)',
  constructor3: 'コンストラクタ(3)',
  constructor4: 'コンストラクタ(4)',
  // 初級プログラミングⅡ 第3回
  encapsulation: 'カプセル化',
  withoutEncapsulation: 'カプセル化なし(1)',
  withEncapsulation: 'カプセル化あり(1)',
  withoutEncapsulation2: 'カプセル化なし(2)',
  withEncapsulation2: 'カプセル化あり(2)',
  withEncapsulation3: 'カプセル化あり(3)',
  withEncapsulation4: 'カプセル化あり(4)',
  withEncapsulation5: 'カプセル化あり(5)',
  withEncapsulation6: 'カプセル化あり(6)',
  withEncapsulation7: 'カプセル化あり(7)',
  // 初級プログラミングⅡ 第4回
  staticMethod1: '静的メソッド(1)',
  staticMethod2: '静的メソッド(2)',
  staticMethod3: '静的メソッド(3)',
  staticMethod4: '静的メソッド(4)',
  staticField1: '静的フィールド(1)',
  staticField2: '静的フィールド(2)',
  staticField3: '静的フィールド(3)',
  staticField4: '静的フィールド(4)',
  staticField5: '静的フィールド(5)',
  staticField6: '静的フィールド(6)',
  // 初級プログラミングⅡ 第5回
  inheritance1: '継承(1)',
  inheritance2: '継承(2)',
  inheritance3: '継承(3)',
  inheritance4: '継承(4)',
  override1: 'オーバーライド(1)',
  override2: 'オーバーライド(2)',
  override3: 'オーバーライド(3)',
  polymorphism1: 'ポリモルフィズム(1)',
  polymorphism2: 'ポリモルフィズム(2)',
  polymorphism3: 'ポリモルフィズム(3)',
  // 初級プログラミングⅡ 第6回
  package1: 'パッケージ(1)',
  package2: 'パッケージ(2)',
  package3: 'パッケージ(3)',
  overload1: 'オーバーロード(1)',
  overload2: 'オーバーロード(2)',
  overload3: 'オーバーロード(3)',
  overload4: 'オーバーロード(4)',
  overloadAndOverride1: 'オーバーロードとオーバーライド(1)',
  // 初級プログラミングⅡ 第7回
  // 初級プログラミングⅡ 第8回
  oop1: 'オブジェクト指向プログラミング(1)',
  oop2: 'オブジェクト指向プログラミング(2)',
  test1: 'ステップ実行のテスト用問題(1)',
  test2: 'ステップ実行のテスト用問題(2)',
  test3: 'ステップ実行のテスト用問題(3)',
  test4: 'ステップ実行のテスト用問題(4)',
  test5: 'チェックポイント取得のテスト用問題',
  test9: 'ステップ実行のテスト用問題(9)',
} as const;
export type ProblemId = keyof typeof problemIdToName;

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
    [
      'multiObject1',
      'multiObject2',
      'multiObject3',
      'multiObject4',
      'multiObject5',
      'multiObject6',
      'garbageCollection1',
      'garbageCollection2',
      'garbageCollection3',
      'garbageCollection4',
      'garbageCollection5',
      'garbageCollection6',
    ],
    // 第2回
    [
      'makeClass1',
      'makeClass2',
      'makeClass3',
      'makeClass4',
      'makeClass5',
      'makeClass6',
      'constructor1',
      'constructor2',
      'constructor3',
      'constructor4',
    ],
    // 第3回
    [
      'encapsulation',
      'withoutEncapsulation',
      'withEncapsulation',
      'withoutEncapsulation2',
      'withEncapsulation2',
      'withEncapsulation3',
      'withEncapsulation4',
      'withEncapsulation5',
      'withEncapsulation6',
      'withEncapsulation7',
    ],
    // 第4回
    [
      'staticMethod1',
      'staticMethod2',
      'staticMethod3',
      'staticMethod4',
      'staticField1',
      'staticField2',
      'staticField3',
      'staticField4',
      'staticField5',
      'staticField6',
    ],
    // 第5回
    [
      'inheritance1',
      'inheritance2',
      'inheritance3',
      'inheritance4',
      'override1',
      'override2',
      'override3',
      'polymorphism1',
      'polymorphism2',
      'polymorphism3',
    ],
    // 第6回
    ['package1', 'package2', 'package3', 'overload1', 'overload2', 'overload3', 'overload4', 'overloadAndOverride1'],
    // 第7回
    ['oop1'],
    // 第8回
    ['oop1'],
  ],
  test: [['test1', 'test2', 'test3', 'test4', 'test5', 'test9', 'oop1', 'oop2']],
};

export const courseIdToLectureIds: Record<CourseId, string[]> = JSON.parse(
  process.env.NEXT_PUBLIC_COURSE_ID_TO_LECTURE_IDS_JSON ?? '{}'
);

export const problemIdToLanguageIdToProgram: Record<ProblemId, Record<LanguageId, string>> = {
  straight: {
    instrumented: `
const t = new Turtle(); // step
t.forward();
t.forward();
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(); // step
        亀.前に進む(); // step
        亀.前に進む(); // step
    }
}
    `,
  },
  straight2: {
    instrumented: `
const t = new Turtle(); // step
t.forward();
t.forward();
t.forward();
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(); // step
        亀.前に進む(); // step
        亀.前に進む(); // step
        亀.前に進む(); // step
    }
}
    `,
  },
  stepBack: {
    instrumented: `
const t = new Turtle(); // step
t.forward();
t.backward();
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(); // step
        亀.前に進む(); // step
        亀.後に戻る(); // step
    }
}
    `,
  },
  stepBack2: {
    instrumented: `
const t = new Turtle(); // step
t.forward();
t.forward();
t.backward();
t.forward();
t.forward();
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(); // step
        亀.前に進む(); // step
        亀.前に進む(); // step
        亀.後に戻る(); // step
        亀.前に進む(); // step
        亀.前に進む(); // step
    }
}
    `,
  },
  turnRight: {
    instrumented: `
const t = new Turtle(); // step
t.forward();
t.turnRight();
t.forward();
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(); // step
        亀.前に進む(); // step
        亀.右を向く(); // step
        亀.前に進む(); // step
    }
}
    `,
  },
  turnRight2: {
    instrumented: `
const t = new Turtle(); // step
t.forward();
t.forward();
t.turnRight();
t.forward();
t.forward();
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(); // step
        亀.前に進む(); // step
        亀.前に進む(); // step
        亀.右を向く(); // step
        亀.前に進む(); // step
        亀.前に進む(); // step
    }
}
    `,
  },
  turnLeftAndRight: {
    instrumented: `
const t = new Turtle(); // step
t.turnRight();
t.forward();
t.turnLeft();
t.forward();
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(); // step
        亀.右を向く(); // step
        亀.前に進む(); // step
        亀.左を向く(); // step
        亀.前に進む(); // step
    }
}
    `,
  },
  turnLeftAndRight2: {
    instrumented: `
const t = new Turtle(); // step
t.forward();
t.turnRight();
t.forward();
t.turnLeft();
t.forward();
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(); // step
        亀.前に進む(); // step
        亀.右を向く(); // step
        亀.前に進む(); // step
        亀.左を向く(); // step
        亀.前に進む(); // step
    }
}
    `,
  },
  turnLeftAndRight3: {
    instrumented: `
const t = new Turtle(); // step
t.turnRight();
t.forward();
t.turnLeft();
t.forward();
t.turnRight();
t.forward();
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(); // step
        亀.右を向く(); // step
        亀.前に進む(); // step
        亀.左を向く(); // step
        亀.前に進む(); // step
        亀.右を向く(); // step
        亀.前に進む(); // step
    }
}
    `,
  },
  turnLeftAndRight4: {
    instrumented: `
const t = new Turtle(); // step
t.forward();
t.forward();
t.turnRight();
t.forward();
t.forward();
t.turnLeft();
t.forward();
t.forward();
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(); // step
        亀.前に進む(); // step
        亀.前に進む(); // step
        亀.右を向く(); // step
        亀.前に進む(); // step
        亀.前に進む(); // step
        亀.左を向く(); // step
        亀.前に進む(); // step
        亀.前に進む(); // step
    }
}
    `,
  },
  square1: {
    instrumented: `
const t = new Turtle(); // step
t.forward();
t.turnRight();
t.forward();
t.turnRight();
t.forward();
`,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(); // step
        亀.前に進む(); // step
        亀.右を向く(); // step
        亀.前に進む(); // step
        亀.右を向く(); // step
        亀.前に進む(); // step
    }
}
    `,
  },
  square2: {
    instrumented: `
const t = new Turtle(<1-5>, <1-4>); // step
t.forward();
t.turnRight();
t.forward();
t.turnRight();
t.forward();
`,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(<1-5>, <1-4>); // step
        亀.前に進む(); // step
        亀.右を向く(); // step
        亀.前に進む(); // step
        亀.右を向く(); // step
        亀.前に進む(); // step
    }
}
    `,
  },
  square3: {
    instrumented: `
const t = new Turtle(<2-5>, <2-5>); // step
t.forward();
t.turnLeft();
t.forward();
t.turnLeft();
t.forward();
t.turnLeft();
t.forward();
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(<2-5>, <2-5>); // step
        亀.前に進む(); // step
        亀.左を向く(); // step
        亀.前に進む(); // step
        亀.左を向く(); // step
        亀.前に進む(); // step
        亀.左を向く(); // step
        亀.前に進む(); // step
    }
}
    `,
  },
  square4: {
    instrumented: `
const t = new Turtle(); // step
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
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(); // step
        亀.前に進む(); // step
        亀.前に進む(); // step
        亀.右を向く(); // step
        亀.前に進む(); // step
        亀.前に進む(); // step
        亀.右を向く(); // step
        亀.前に進む(); // step
        亀.前に進む(); // step
        亀.右を向く(); // step
        亀.前に進む(); // step
        亀.前に進む(); // step
    }
}
    `,
  },

  variable: {
    instrumented: `
s.set('x', <1-5>);
const t = new Turtle(s.get('x'), <1-5>); // step
t.forward();
 `,
    java: `
public class Main {
    public static void main(String[] args) {
        int x = <1-5>; // step
        Turtle 亀 = new Turtle(x, <1-5>); // step
        亀.前に進む(); // step
    }
}
    `,
  },
  variable2: {
    instrumented: `
s.set('a', <2-6>);
s.set('a', s.get('a') - 1);
const t = new Turtle(<1-5>, s.get('a')); // step
t.forward();
 `,
    java: `
public class Main {
    public static void main(String[] args) {
        int a = <2-6>; // step
        a = a - 1; // step
        Turtle 亀 = new Turtle(<1-5>, a); // step
        亀.前に進む(); // step
    }
}
    `,
  },
  variable3: {
    instrumented: `
s.set('x', <1-4>);
s.set('x', s.get('x') + 1);
s.set('y', s.get('x') + 1);
const t = new Turtle(s.get('x'), s.get('y')); // step
t.forward();
`,
    java: `
public class Main {
    public static void main(String[] args) {
        int x = <1-4>; // step
        x = x + 1; // step
        int y = x + 1; // step
        Turtle 亀 = new Turtle(x, y); // step
        亀.前に進む(); // step
    }
}
    `,
  },
  variable4: {
    instrumented: `
s.set('b', <1-4>);
s.set('b', s.get('b') + 1);
s.set('a', s.get('b') - 2);
const t = new Turtle(s.get('a') + 1, s.get('b')); // step
t.forward();
`,
    java: `
public class Main {
    public static void main(String[] args) {
        int b = <1-4>; // step
        b = b + 1; // step
        int a = b - 2; // step
        Turtle 亀 = new Turtle(a + 1, b); // step
        亀.前に進む(); // step
    }
}
    `,
  },
  variable5: {
    instrumented: `
s.set('x', <1-5>);
s.set('x', s.get('x') - 1);
s.set('y', s.get('x') * 2);
s.set('y', s.get('y') / 3);
const t = new Turtle(s.get('x') + 1, s.get('y') + 1); // step
t.forward();
`,
    java: `
public class Main {
    public static void main(String[] args) {
        int x = <1-5>; // step
        x--; // step
        int y = x * 2; // step
        y /= 3; // step
        Turtle 亀 = new Turtle(x + 1, y + 1); // step
        亀.前に進む(); // step
    }
}
    `,
  },
  variable6: {
    instrumented: `
s.set('a', <1-3>);
s.set('b', s.get('a') * 2);
s.set('c', s.get('b') - 2);
const t = new Turtle(s.get('c'), s.get('b')); // step
t.forward();
`,
    java: `
public class Main {
    public static void main(String[] args) {
        int a = <1-3>; // step
        int b = a * 2; // step
        int c = b - 2; // step
        Turtle 亀 = new Turtle(c, b); // step
        亀.前に進む(); // step
    }
}
    `,
  },
  variable7: {
    instrumented: `
s.set('x', <0-2>);
s.set('y', (s.get('x') * 2) + 1);
s.set('z', (s.get('y') * 2) + (s.get('x') / 2));
s.set('x', s.get('z') / 3);
const t = new Turtle(s.get('x'), s.get('y')); // step
t.forward();
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        int x = <0-2>; // step
        int y = (x * 2) + 1; // step
        int z = (y * 2) + (x / 2); // step
        x = z / 3; // step
        Turtle 亀 = new Turtle(x, y); // step
        亀.前に進む(); // step
    }
}
    `,
  },
  variable8: {
    instrumented: `
s.set('x', <0-2>);
s.set('y', (s.get('x') * 3) + 2);
s.set('z', (s.get('y') * 2) - (s.get('x') * 3));
s.set('x', (s.get('z') / 4) % 7);
s.set('y', (s.get('x') + s.get('y')) % 7);
const t = new Turtle(s.get('x'), s.get('y')); // step
t.backward();
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        int x = <0-2>; // step
        int y = (x * 3) + 2; // step
        int z = (y * 2) - (x * 3); // step
        x = (z / 4) % 7; // step
        y = (x + y) % 7; // step
        Turtle 亀 = new Turtle(x, y); // step
        亀.後に戻る(); // step
    }
}
    `,
  },
  variable9: {
    instrumented: `
s.set('x', <0-3>);
s.set('y', (s.get('x') * 4) + 3);
s.set('z', (s.get('y') * 3) - (s.get('x') * 2));
s.set('x', ((s.get('z') / 5) + s.get('x')) % 7);
s.set('y', ((s.get('x') * 2) + s.get('y')) % 7);
const t = new Turtle(s.get('x'), s.get('y')); // step
t.forward();
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        int x = <0-3>; // step
        int y = (x * 4) + 3; // step
        int z = (y * 3) - (x * 2); // step
        x = ((z / 5) + x) % 7; // step
        y = ((x * 2) + y) % 7; // step
        Turtle 亀 = new Turtle(x, y); // step
        亀.前に進む(); // step
    }
}
    `,
  },
  variable10: {
    instrumented: `
s.set('x', <0-3>);
s.set('y', (s.get('x') * 5) + 4);
s.set('z', (s.get('y') * 2) - (s.get('x') * 3));
s.set('w', (s.get('z') + s.get('x')) % 5);
s.set('x', ((s.get('z') / 6) + s.get('w')) % 7);
s.set('y', ((s.get('x') * 3) + s.get('y')) % 7);
const t = new Turtle(s.get('x'), s.get('y')); // step
t.forward();
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        int x = <0-3>; // step
        int y = (x * 5) + 4; // step
        int z = (y * 2) - (x * 3); // step
        int w = (z + x) % 5; // step
        x = ((z / 6) + w) % 7; // step
        y = ((x * 3) + y) % 7; // step
        Turtle 亀 = new Turtle(x, y); // step
        亀.前に進む(); // step
    }
}
    `,
  },
  while1: {
    instrumented: `
const t = new Turtle(); // step
s.set('i', 0);
while (s.get('i') < <3-5>) {
  t.forward();
  s.set('i', s.get('i') + 1);
}
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(); // step
        int i = 0; // step
        while (i < <3-5>) {
            亀.前に進む(); // step
            i++; // step
        }
    }
}
    `,
  },
  while2: {
    instrumented: `
const t = new Turtle(<0-1>, <0-1>); // step
s.set('i', <1-2>);
while (s.get('i') < <4-6>) {
  t.forward();
  s.set('i', s.get('i') + 1);
}
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(<0-1>, <0-1>); // step
        int i = <1-2>; // step
        while (i < <4-6>) {
            亀.前に進む(); // step
            i++; // step
        }
    }
}
    `,
  },
  while3: {
    instrumented: `
const t = new Turtle(); // step
s.set('i', 0);
while (s.get('i') < <2-3>) {
  s.set('i', s.get('i') + 1);
  t.forward();
  t.turnRight();
}
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(); // step
        int i = 0; // step
        while (i < <2-3>) {
            i++; // step
            亀.前に進む(); // step
            亀.右を向く(); // step
        }
    }
}
    `,
  },
  while4: {
    instrumented: `
const t = new Turtle(<0-1>, <0-1>); // step
t.turnRight();
s.set('i', <1-2>);
while (s.get('i') < <4-5>) {
  t.forward();
  t.forward();
  t.turnLeft();
  s.set('i', s.get('i') + 1);
}
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(<0-1>, <0-1>); // step
        亀.右を向く(); // step
        int i = <1-2>; // step
        while (i < <4-5>) {
            亀.前に進む(); // step
            亀.前に進む(); // step
            亀.左を向く(); // step
            i++; // step
        }
    }
}
    `,
  },
  while5: {
    instrumented: `
const t = new Turtle(); // step
s.set('i', <1-2>);
while (s.get('i') < <3-4>) {
  t.forward();
  t.turnRight();
  t.forward();
  t.turnLeft();
  s.set('i', s.get('i') + 1);
}
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(); // step
        int i = <1-2>; // step
        while (i < <3-4>) {
            亀.前に進む(); // step
            亀.右を向く(); // step
            亀.前に進む(); // step
            亀.左を向く(); // step
            i++; // step
        }
    }
}
    `,
  },
  for1: {
    instrumented: `
const t = new Turtle(); // step
for (s.set('i', 0); s.get('i') < <3-5>; s.set('i', s.get('i') + 1)) {
  t.forward();
}
delete s.vars['i'];
       `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(); // step
        for (int i = 0; i < <3-5>; i++) { // step
            亀.前に進む(); // step
        }
    }
}
    `,
  },
  for2: {
    instrumented: `
const t = new Turtle(<1-2>, <1-2>); // step
for (s.set('i', <1-2>); s.get('i') < <4-6>; s.set('i', s.get('i') + 1)) {
  t.forward();
}
delete s.vars['i'];
       `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(<1-2>, <1-2>); // step
        for (int i = <1-2>; i < <4-6>; i++) { // step
            亀.前に進む(); // step
        }
    }
}
    `,
  },
  for3: {
    instrumented: `
const t = new Turtle(); // step
s.set('i', 0);
for (; s.get('i') < <2-3>;) {
  t.forward();
  t.turnRight();
  s.set('i', s.get('i') + 1);
}
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(); // step
        int i = 0; // step
        for (; i < <2-3>;) {
            亀.前に進む(); // step
            亀.右を向く(); // step
            i++; // step
        }
    }
}
    `,
  },
  for4: {
    instrumented: `
const t = new Turtle(<1-2>, <1-2>); // step
s.set('i', 1);
for (; s.get('i') < <3-4>;) {
  t.forward();
  t.turnRight();
  s.set('i', s.get('i') + 1);
}
t.backward();
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(<1-2>, <1-2>); // step
        int i = 1; // step
        for (; i < <3-4>;) {
            亀.前に進む(); // step
            亀.右を向く(); // step
            i++; // step
        }
        亀.後に戻る(); // step
    }
}
    `,
  },
  for5: {
    instrumented: `
s.set('x', 0);
for (s.set('i', 2); s.get('i') <= <4-5>; s.set('i', s.get('i') + 1)) {
  s.set('x', s.get('x') + s.get('i'));
}
delete s.vars['i'];
s.set('x', s.get('x') / 3);
const t = new Turtle(s.get('x') + 1, 0); // step
t.forward();
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        int x = 0; // step
        for (int i = 2; i <= <4-5>; i++) { // step
            x += i; // step
        }
        x /= 3; // step
        Turtle 亀 = new Turtle(x + 1, 0); // step
        亀.前に進む(); // step
    }
}
    `,
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
const t = new Turtle(s.get('a') % 6, s.get('b') % 6); // step
t.forward();
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        int a = 0; // step
        int b = 100; // step
        for (int i = <4-5>; i > 0; i--) { // step
            a += i; // step
            b -= i; // step
        }
        a /= 4; // step
        b /= 5; // step
        Turtle 亀 = new Turtle(a % 6, b % 6); // step
        亀.前に進む(); // step
    }
}
    `,
  },
  for7: {
    instrumented: `
const t = new Turtle(3, 3); // step
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
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(3, 3); // step
        int sum = 0; // step
        for (int i = 1; i <= <4-6>; i++) { // step
            sum += i; // step
            亀.前に進む(); // step
            亀.左を向く(); // step
        }
        for (int i = sum / 4; i >= 0; i--) { // step
            亀.前に進む(); // step
            亀.前に進む(); // step
            亀.右を向く(); // step
        }
    }
}
    `,
  },
  doubleLoop1: {
    instrumented: `
const t = new Turtle(); // step
for (s.set('i', 0); s.get('i') < <2-3>; s.set('i', s.get('i') + 1)) {
  for (s.set('j', 0); s.get('j') < <2-3>; s.set('j', s.get('j') + 1)) {
      t.forward();
  }
  delete s.vars['j'];
  t.turnRight();
}
delete s.vars['i'];
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        for (int i = 0; i < <2-3>; i++) { // step
            for (int j = 0; j < <2-3>; j++) { // step
                t.前に進む(); // step
            }
            t.右を向く(); // step
        }
    }
}
    `,
  },
  doubleLoop2: {
    instrumented: `
const t = new Turtle(); // step
t.turnRight();
for (s.set('i', 0); s.get('i') < <2-3>; s.set('i', s.get('i') + 1)) {
  for (s.set('j', 0); s.get('j') < <2-3>; s.set('j', s.get('j') + 1)) {
      t.forward();
  }
  delete s.vars['j'];
  t.turnLeft();
}
delete s.vars['i'];
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.右を向く(); // step
        for (int i = 0; i < <2-3>; i++) { // step
            for (int j = 0; j < <2-3>; j++) { // step
                t.前に進む(); // step
            }
            t.左を向く(); // step
        }
    }
}
    `,
  },
  doubleLoop3: {
    instrumented: `
const t = new Turtle(); // step
for (s.set('i', <3-4>); s.get('i') > 0; s.set('i', s.get('i') - 1)) {
  for (s.set('j', 0); s.get('j') < s.get('i'); s.set('j', s.get('j') + 1)) {
    t.forward();
  }
  delete s.vars['j'];
  t.turnRight();
}
delete s.vars['i'];
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        for (int i = <3-4>; i > 0; i--) { // step
            for (int j = 0; j < i; j++) { // step
                t.前に進む(); // step
            }
            t.右を向く(); // step
        }
    }
}
    `,
  },
  doubleLoop4: {
    instrumented: `
const t = new Turtle(); // step
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
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        for (int i = 3; i > 0; i--) { // step
            int j = i; // step
            while (j >= 0) {
                t.前に進む(); // step
                j--; // step
            }
            t.右を向く(); // step
        }
    }
}
    `,
  },
  doubleLoop5: {
    instrumented: `
const t = new Turtle(); // step
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
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        for (int i = 0; i < <3-4>; i++) { // step
            for (int j = <0-1>; j <= i; j++) { // step
                t.前に進む(); // step
            }
            t.右を向く(); // step
            for (int k = <0-1>; k < i; k++) { // step
                t.前に進む(); // step
            }
            t.左を向く(); // step
        }
    }
}
    `,
  },
  if1: {
    instrumented: `
const t = new Turtle(); // step
for (s.set('i', 0); s.get('i') < <7-9>; s.set('i', s.get('i') + 1)) {
  t.forward();
  if (s.get('i') % 3 === 2) {
    t.turnRight();
  }
}
delete s.vars['i'];
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        for (int i = 0; i < <7-9>; i++) { // step
            t.前に進む(); // step
            if (i % 3 == 2) {
                t.右を向く(); // step
            }
        }
    }
}
    `,
  },
  if2: {
    instrumented: `
const t = new Turtle(<1-2>, <1-2>); // step
t.turnRight();
for (s.set('i', 0); s.get('i') < <6-8>; s.set('i', s.get('i') + 1)) {
  t.forward();
  if (s.get('i') % 3 === 1) {
    t.turnLeft();
  }
}
delete s.vars['i'];
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(<1-2>, <1-2>); // step
        t.右を向く(); // step
        for (int i = 0; i < <7-9>; i++) { // step
            t.前に進む(); // step
            if (i % 3 == 1) {
                t.左を向く(); // step
            }
        }
    }
}
    `,
  },
  if3: {
    instrumented: `
const t = new Turtle(); // step
for (s.set('i', 0); s.get('i') < <4-5>; s.set('i', s.get('i') + 1)) {
  t.forward();
  if (s.get('i') % 2 === 0) {
    t.turnRight();
  } else {
    t.turnLeft();
  }
}
delete s.vars['i'];
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        for (int i = 0; i < <4-5>; i++) { // step
            t.前に進む(); // step
            if (i % 2 == 0) {
                t.右を向く(); // step
            } else {
                t.左を向く(); // step
            }
        }
    }
}
    `,
  },
  if4: {
    instrumented: `
const t = new Turtle(); // step
for (s.set('i', 0); s.get('i') < <4-5>; s.set('i', s.get('i') + 1)) {
  t.forward();
  if (s.get('i') % 3 === 0) {
    t.turnRight();
  } else {
    t.turnLeft();
  }
}
delete s.vars['i'];
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        for (int i = 0; i < <4-5>; i++) { // step
            t.前に進む(); // step
            if (i % 3 == 0) {
                t.右を向く(); // step
            } else {
                t.左を向く(); // step
            }
        }
    }
}
    `,
  },
  if5: {
    instrumented: `
const t = new Turtle(); // step
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
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        for (int i = 0; i < <3-4>; i++) { // step
            for (int j = 0; j < <2-3>; j++) { // step
                if (j % 2 == 0) {
                    t.前に進む(); // step
                } else {
                    t.右を向く(); // step
                }
            }
            t.前に進む(); // step
            t.左を向く(); // step
        }
    }
}
    `,
  },
  elseIf1: {
    instrumented: `
const t = new Turtle(); // step
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
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        for (int i = 0; i < <4-6>; i++) { // step
            if (i < 2)
                t.前に進む(); // step
            else if (i == 2)
                t.左を向く(); // step
            else
                t.後に戻る(); // step
        }
    }
}
    `,
  },
  elseIf2: {
    instrumented: `
const t = new Turtle(); // step
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
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        for (int i = 0; i < <5-7>; i++) { // step
            if (i % 4 == 0)
                t.前に進む(); // step
            else if (i % 4 == 1)
                t.右を向く(); // step
            else if (i % 4 == 2)
                t.前に進む(); // step
            else
                t.左を向く(); // step
        }
    }
}
    `,
  },
  elseIf3: {
    instrumented: `
const t = new Turtle(); // step
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
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        for (int i = 0; i < 7; i++) { // step
            if (i < 2)
                t.前に進む(); // step
            else if (i == 2)
                t.左を向く(); // step
            else if (i == <4-5>)
                t.右を向く(); // step
            else
                t.後に戻る(); // step
        }
    }
}
    `,
  },
  elseIf4: {
    instrumented: `
const t = new Turtle(); // step
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
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        for (int i = 0; i < <6-7>; i++) { // step
            if (i % 5 == 0)
                t.前に進む(); // step
            else if (i % 5 == 1)
                t.左を向く(); // step
            else if (i % 5 == 2)
                t.後に戻る(); // step
            else
                t.右を向く(); // step
        }
    }
}
    `,
  },
  elseIf5: {
    instrumented: `
const t = new Turtle(); // step
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
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        for (int i = 0; i < <7-8>; i++) { // step
            if (i % 5 == 1)
                t.右を向く(); // step
            else if (i % 5 == 3)
                t.左を向く(); // step
            else
                t.前に進む(); // step
        }
    }
}
    `,
  },
  switch1: {
    instrumented: `
const t = new Turtle(); // step
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
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        for (int i = 0; i < <5-7>; i++) { // step
            switch (i) {
                case 0: case 1:
                    t.前に進む(); break; // step
                case 2:
                    t.左を向く(); break; // step
                default:
                    t.後に戻る(); break; // step
            }
        }
    }
}
    `,
  },
  switch2: {
    instrumented: `
const t = new Turtle(); // step
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
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        for (int i = 0; i < <5-7>; i++) { // step
            switch (i % 4) {
                case 1:
                    t.右を向く(); break; // step
                case 3:
                    t.左を向く(); break; // step
                default:
                    t.前に進む(); break; // step
            }
        }
    }
}
    `,
  },
  switch3: {
    instrumented: `
const t = new Turtle(2, 2); // step
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
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        for (int i = 0; i < <6-7>; i++) { // step
            switch (i) {
                case 0:
                case 1:
                    t.前に進む(); // step
                    break;
                case 2:
                    t.左を向く(); // step
                    break;
                case 4:
                case 5:
                    t.右を向く(); // step
                    break;
                default:
                    t.後に戻る(); // step
            }
        }
    }
}
    `,
  },
  switch4: {
    instrumented: `
const t = new Turtle(); // step
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
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        for (int i = 0; i < <7-8>; i++) { // step
            switch (i % 5) {
                case 0:
                    t.左を向く(); // step
                    break;
                case 1:
                    t.後に戻る(); // step
                    break;
                case 2:
                    t.右を向く(); // step
                    break;
                default:
                    t.前に進む(); // step
            }
        }
    }
}
    `,
  },
  switch5: {
    instrumented: `
const t = new Turtle(); // step
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
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        for (int i = 0; i < <9-10>; i++) { // step
            switch (i % 6) {
                case 0:
                    t.左を向く(); // step
                    break;
                case 1:
                case 2:
                    t.後に戻る(); // step
                    break;
                case 3:
                    t.右を向く(); // step
                    break;
                default:
                    t.前に進む(); // step
            }
        }
    }
}
    `,
  },
  break1: {
    instrumented: `
const t = new Turtle(); // step
while (true) {
  if (!t.canMoveForward()) break;
  t.forward();
}
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        while (true) {
            if (!t.前に進めるか()) break;
            t.前に進む(); // step
        }
    }
}
    `,
  },
  break2: {
    instrumented: `
const t = new Turtle(<3-4>,<3-4>); // step
while (true) {
  if (!t.canMoveForward()) break;
  t.forward();
  t.turnRight();

  if (!t.canMoveForward()) break;
  t.forward();
  t.turnLeft();
}
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(<3-4>, <3-4>); // step
        while (true) {
            if (!t.前に進めるか()) break;
            t.前に進む(); // step
            t.右を向く(); // step

            if (!t.前に進めるか()) break;
            t.前に進む(); // step
            t.左を向く(); // step
        }
    }
}
    `,
  },
  break3: {
    instrumented: `
const t = new Turtle(<4-6>, <4-6>); // step
for (s.set('i', 0); s.get('i') < 4; s.set('i', s.get('i') + 1)) {
  while (true) {
    t.forward();
    if (!t.canMoveForward()) break;
  }
  t.turnRight();
}
delete s.vars['i'];
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(<4-6>, <4-6>); // step
        for (int i = 0; i < 4; i++) { // step
            for (;;) {
                t.前に進む(); // step
                if (!t.前に進めるか()) break;
            }
            t.右を向く(); // step
        }
    }
}
    `,
  },
  break4: {
    instrumented: `
const t = new Turtle(<3-5>, <3-5>); // step
for (s.set('i', 0); s.get('i') < 3; s.set('i', s.get('i') + 1)) {
  while (true) {
    if (!t.canMoveForward()) break;
    t.forward();
  }
  t.turnLeft();
}
delete s.vars['i'];
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(<3-5>, <3-5>); // step
        for (int i = 0; i < 3; i++) { // step
            while (true) {
                if (!t.前に進めるか()) break;
                t.前に進む(); // step
            }
            t.左を向く(); // step
        }
    }
}
    `,
  },
  break5: {
    instrumented: `
const t = new Turtle(<4-6>, <4-6>); // step
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
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(<4-6>, <4-6>); // step
        for (int i = 0; i < 3; i++) { // step
            for (int j = 0; j < 6; j++) { // step
                if (!t.前に進めるか()) break;
                t.前に進む(); // step
                if (j % 3 == 0) {
                    t.左を向く(); // step
                } else {
                    t.右を向く(); // step
                }
            }
            t.右を向く(); // step
        }
    }
}
    `,
  },
  continue1: {
    instrumented: `
const t = new Turtle(); // step
for (s.set('i', 0); s.get('i') < <3-5>; s.set('i', s.get('i') + 1)) {
  if (s.get('i') == 0) {
    continue;
  }
  t.forward();
}
delete s.vars['i'];
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        for (int i = 0; i < <3-5>; i++) { // step
            if (i == 0) {
                continue;
            }
            t.前に進む(); // step
        }
    }
}
    `,
  },
  continue2: {
    instrumented: `
const t = new Turtle(); // step
for (s.set('i', 0); s.get('i') < <5-7>; s.set('i', s.get('i') + 1)) {
  if (s.get('i') % <2-3> == 1) {
    t.turnRight();
    continue;
  }
  t.forward();
}
delete s.vars['i'];
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        for (int i = 0; i < <5-7>; i++) { // step
            if (i % <2-3> == 1) {
                t.右を向く(); // step
                continue;
            }
            t.前に進む(); // step
        }
    }
}
    `,
  },
  continue3: {
    instrumented: `
const t = new Turtle(); // step
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
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        for (int i = 0; i < 2; i++) { // step
            for (int j = i * 4; j < 8; j++) { // step
                if (j % 4 == 1) {
                    t.右を向く(); continue; // step
                } else if (j % 4 == 3) {
                    t.左を向く(); continue; // step
                }
                t.前に進む(); // step
            }
            t.左を向く(); // step
        }
    }
}
    `,
  },
  continue4: {
    instrumented: `
const t = new Turtle(); // step
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
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        for (int i = 0; i < 3; i++) { // step
            for (int j = i; j < 6; j++) { // step
                if (j % 2 == 0) {
                    t.右を向く(); continue; // step
                }
                if (t.前に進めるか()) {
                    t.前に進む(); // step
                }
            }
            t.左を向く(); // step
        }
    }
}
    `,
  },
  continue5: {
    instrumented: `
const t = new Turtle(); // step
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
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        for (int i = 0; i < 3; i++) { // step
            for (int j = i + 1; j < 6; j++) { // step
                if (j % 4 == 0) {
                    t.左を向く(); continue; // step
                } else if (j % 3 == 2) {
                    t.右を向く(); continue; // step
                }
                if (t.前に進めるか()) {
                    t.前に進む(); // step
                }
            }
        }
    }
}
    `,
  },
  method1: {
    instrumented: `
const t = new Turtle(); // step
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
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step: 1
        二歩前に進める(t); // caller
        t.右を向く(); // step: 2
        三歩前に進める(t); // caller
    }
    static void 二歩前に進める(Turtle t) {
        t.前に進む(); // step: 3
        t.前に進む(); // step: 4
    }
    static void 三歩前に進める(Turtle t) {
        t.前に進む(); // step: 5
        t.前に進む(); // step: 6
        t.前に進む(); // step: 7
    }
}
    `,
  },
  method2: {
    instrumented: `
const t = new Turtle(); // step
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

    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        二歩前に進める(t); // caller
        後ろを向く(t); // caller
        t.前に進む(); // step
    }
    static void 二歩前に進める(Turtle t) {
        t.前に進む(); // step
        t.前に進む(); // step
    }
    static void 後ろを向く(Turtle t) {
        t.右を向く(); // step
        t.右を向く(); // step
    }
}
    `,
  },
  method3: {
    instrumented: `
const t = new Turtle(); // step
call(forwardGivenSteps, 't', 'n')(t, <3-4>);
t.turnRight();
call(forwardGivenSteps, 't', 'n')(t, 2);

function forwardGivenSteps(t, n) {
  for (s.set('i', 0); s.get('i') < n; s.set('i', s.get('i') + 1)) {
    t.forward();
  }
  delete s.vars['i'];
}
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        N歩前に進める(t, <3-4>); // caller
        t.右を向く(); // step
        N歩前に進める(t, 2); // caller
    }

    static void N歩前に進める(Turtle t, int n) {
        for (int i = 0; i < n; i++) { // step
            t.前に進む(); // step
        }
    }
}
    `,
  },
  method4: {
    instrumented: `
const t = new Turtle(); // step
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
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        二歩前に進める(t); // caller
        t.右を向く(); // step
        四歩前に進める(t); // caller
    }
    static void 二歩前に進める(Turtle t) {
        t.前に進む(); // step
        t.前に進む(); // step
    }
    static void 四歩前に進める(Turtle t) {
        二歩前に進める(t); // caller
        二歩前に進める(t); // caller
    }
}
    `,
  },
  method5: {
    instrumented: `
const t = new Turtle(); // step
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
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        正方形を描く(t); // caller
        t.後に戻る(); // step
        t.後に戻る(); // step
        正方形を描く(t); // caller
    }
    static void 正方形を描く(Turtle t) {
        for (int i = 0; i < 3; i++) { // step
            t.前に進む(); // step
            t.右を向く(); // step
        }
    }
}
    `,
  },
  return1: {
    instrumented: `
const t = new Turtle(); // step
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
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        int x = 二倍する(<2-3>); // step // caller
        N歩前に進める(t, x); // caller
    }
    static void N歩前に進める(Turtle t, int n) {
        for (int i = 0; i < n; i++) { // step
            t.前に進む(); // step
        }
    }
    static int 二倍する(int a) {
        return a * 2;
    }
}
    `,
  },
  return2: {
    instrumented: `
const t = new Turtle(); // step
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
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        int x = 二倍する(2); // step // caller
        N歩前に進める(t, x); // caller
        t.右を向く(); // step
        x = 二倍する(x - 1); // step // caller
        N歩前に進める(t, x); // caller
    }
    static void N歩前に進める(Turtle t, int n) {
        for (int i = 0; i < n; i++) { // step
            t.前に進む(); // step
        }
    }
    static int 二倍する(int a) {
        return a * 2;
    }
}
    `,
  },
  return3: {
    instrumented: `
const t = new Turtle(); // step
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
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        N歩前に進める(t, 加算する(1, 1)); // caller
        N歩前に進める(t, 加算する(1, 2)); // caller
    }
    static void N歩前に進める(Turtle t, int n) {
        for (int i = 0; i < n; i++) { // step
            t.前に進む(); // step
        }
    }
    static int 加算する(int a, int b) {
        return a + b; // step
    }
}
    `,
  },
  return4: {
    instrumented: `
const t = new Turtle(); // step
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

    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        for (int i = 0; i < <3-4>; i++) { // step
            if (偶数か(i)) { // caller
                t.右を向く(); // step
                二歩前に進める(t); // caller
            } else {
                二歩前に進める(t); // caller
                t.右を向く(); // step
                t.右を向く(); // step
            }
        }
    }
    static void 二歩前に進める(Turtle t) {
        t.前に進む(); // step
        t.前に進む(); // step
    }
    static boolean 偶数か(int a) {
        return a % 2 == 0;
    }
}
    `,
  },
  return5: {
    instrumented: `
const t = new Turtle(); // step
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
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        for (int i = 0; i < 3; i++) { // step
            for (int j = 0; j < 3; j++) { // step
                if (等しいか(i, j)) // caller
                    t.右を向く(); // step
                else
                    二歩前に進める(t); // caller
            }
            t.左を向く(); // step
        }
    }
    static void 二歩前に進める(Turtle t) {
        t.前に進む(); // step
        t.前に進む(); // step
    }
    static boolean 等しいか(int a, int b) {
        return a == b;
    }
}
    `,
  },

  array1: {
    instrumented: `
const t = new Turtle(); // step
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
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        int[] arr = { 2, <1-2>, <1-2> }; // step
        for (int i = 0; i < arr.length; i++) { // step
            N歩前に進める(t, arr[i]); // caller
            t.右を向く(); // step
        }
    }
    static void N歩前に進める(Turtle t, int n) {
        for (int i = 0; i < n; i++) { // step
            t.前に進む(); // step
        }
    }
}
    `,
  },
  array2: {
    instrumented: `
const t = new Turtle(); // step
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
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        int[] arr = { <4-5>, <3-4>, <3-4> }; // step
        for (int i = 0; i < arr.length; i++) { // step
            N歩前に進める(t, arr[i]); // caller
            t.右を向く(); // step
        }
    }
    static void N歩前に進める(Turtle t, int n) {
        for (int i = 0; i < n; i++) { // step
            t.前に進む(); // step
        }
    }
}
    `,
  },
  array3: {
    instrumented: `
const t = new Turtle(); // step
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
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        int[] arr = { 0, 1, 0, 2, 0 }; // step
        for (int i = 0; i < arr.length; i++) { // step
            switch (arr[i]) {
                case 0:
                    t.前に進む(); break; // step
                case 1:
                    t.右を向く(); break; // step
                case 2:
                    t.左を向く(); break; // step
            }
        }
    }
}
    `,
  },
  array4: {
    instrumented: `
const t = new Turtle(); // step
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
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        int[] arr = { 0, 1, 0, 2, 0 }; // step
        for (int cmd : arr) { // step
            switch (cmd) {
                case 0:
                    t.前に進む(); break; // step
                case 1:
                    t.右を向く(); break; // step
                case 2:
                    t.左を向く(); break; // step
            }
        }
    }
}
    `,
  },
  array5: {
    instrumented: `
const t = new Turtle(); // step
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
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        int[] arr = { 0, 1, 0, 2, 0, 3, 0 }; // step
        int steps = 1; // step
        for (int cmd : arr) { // step
            switch (cmd) {
                case 0:
                    for (int i = 0; i < steps; i++) { // step
                        t.前に進む(); // step
                    }
                    break;
                case 1:
                    t.右を向く(); break; // step
                case 2:
                    t.左を向く(); break; // step
                case 3:
                    steps++; break; // step
            }
        }
    }
}
    `,
  },
  string1: {
    instrumented: `
const t = new Turtle(); // step
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
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        String s = "frflf"; // step
        for (int i = 0; i < s.length(); i++) { // step
            switch (s.charAt(i)) {
                case 'f':
                    t.前に進む(); break; // step
                case 'r':
                    t.右を向く(); break; // step
                case 'l':
                    t.左を向く(); break; // step
            }
        }
    }
}
    `,
  },
  string2: {
    instrumented: `
const t = new Turtle(); // step
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
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        String s = "ffbrfl"; // step
        for (int i = 0; i < s.length(); i++) { // step
            switch (s.charAt(i)) {
                case 'f':
                    t.前に進む(); break; // step
                case 'r':
                    t.右を向く(); break; // step
                case 'l':
                    t.左を向く(); break; // step
                case 'b':
                    t.後に戻る(); break; // step
            }
        }
    }
}
    `,
  },
  string3: {
    instrumented: `
const t = new Turtle(); // step
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
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        String s = "frflf"; // step
        for (char ch : s.toCharArray()) { // step
            switch (ch) {
                case 'f':
                    t.前に進む(); break; // step
                case 'r':
                    t.右を向く(); break; // step
                case 'l':
                    t.左を向く(); break; // step
            }
        }
    }
}
    `,
  },
  string4: {
    instrumented: `
const t = new Turtle(); // step
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
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        String[] cmds = { "ri", "aa", "fo" }; // step
        for (String cmd : cmds) { // step
            t.前に進む(); // step
            parse(t, cmd); // caller
        }
    }
    static void parse(Turtle t, String c) {
        if (c.equals("fo"))
            t.前に進む(); // step
        else if (c.equals("ri"))
            t.右を向く(); // step
    }
}
    `,
  },
  string5: {
    instrumented: `
const t = new Turtle(); // step
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
    `,
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        String[] cmds = { "ri", "add", "fo", "add", "le", "fo", "fo" }; // step
        int x = 0; // step
        for (String cmd : cmds) { // step
            parse(t, cmd, x); // caller
            if (cmd.equals("add")) {
                x++; // step
            }
        }
    }
    static void parse(Turtle t, String c, int x) {
        if (c.equals("fo"))
            N歩前に進める(t, x); // caller
        else if (c.equals("ri"))
            t.右を向く(); // step
        else if (c.equals("le"))
            t.左を向く(); // step
    }
    static void N歩前に進める(Turtle t, int n) {
        for (int i = 0; i < n; i++) { // step
            t.前に進む(); // step
        }
    }
}
    `,
  },
  oop1: {
    instrumented: `
const t1 = new Turtle(1, 1); // step
const t2 = new Turtle(3, 3); // step
t1.forward();
t2.forward();
t1.forward();
t2.forward();
`,
    java: `
public class Main {
  public static void main(String[] args) {
    Turtle t1 = new Turtle(1, 1); // step
    Turtle t2 = new Turtle(3, 3); // step
    t1.前に進む(); // step
    t2.前に進む(); // step
    t1.前に進む(); // step
    t2.前に進む(); // step
  }
}
`,
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
    this.speed = speed; // step
    this.c = new Turtle(x, y); // step
  }
  forward() {
    for (s.set('i', 0); s.get('i') < this.speed; s.set('i', s.get('i') + 1)) {
      this.c.forward();
    }
    delete s.vars['i'];
  }
}

main();
`,
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
    this.speed = speed; // step
    this.c = new Turtle(x, y); // step
  }
  public void forward() {
    for (int i = 0; i < this.speed; i++) {
      this.c.前に進む(); // step
    }
  }
}
`,
  },
  // ----------- 初級プログラミングⅡ 第1回 ここから -----------
  multiObject1: {
    // 独自クラスを定義するコードでは `main()` 関数を定義すること。
    instrumented: `
const t1 = new Turtle(1, 1); // step
const t2 = new Turtle(3, 3); // step
t1.前に進む(); // step
t1.右を向く(); // step
t2.前に進む(); // step
t2.左を向く(); // step
`,
    java: `
public class Main {
  public static void main(String[] args) {
    Turtle t1 = new Turtle(1, 1); // step
    Turtle t2 = new Turtle(3, 3); // step
    t1.前に進む(); // step
    t1.右を向く(); // step
    t2.前に進む(); // step
    t2.左を向く(); // step
  }
}
`,
  },
  multiObject2: {
    // 独自クラスを定義するコードでは `main()` 関数を定義すること。
    instrumented: `
const t1 = new Turtle(1, 1); // step
t1.前に進む(); // step
t1.右を向く(); // step
const t2 = new Turtle(3, 3); // step
t2.前に進む(); // step
t2.左を向く(); // step
t2.前に進む(); // step
`,
    java: `
public class Main {
  public static void main(String[] args) {
    Turtle t1 = new Turtle(1, 1); // step
    t1.前に進む(); // step
    t1.右を向く(); // step
    Turtle t2 = new Turtle(3, 3); // step
    t2.前に進む(); // step
    t2.左を向く(); // step
    t2.前に進む(); // step
  }
}
`,
  },
  multiObject3: {
    instrumented: `
const t1 = new Turtle(1, 4); // step
const t2 = new Turtle(5, 4); // step
const t3 = new Turtle(2, 1); // step

t1.右を向く(); // step
t1.右を向く(); // step
t1.前に進む(); // step

t2.左を向く(); // step
t2.左を向く(); // step
t2.前に進む(); // step

t3.右を向く(); // step
t3.前に進む(); // step
t3.前に進む(); // step
`,
    java: `
public class Main {
  public static void main(String[] args) {
    Turtle t1 = new Turtle(1, 4); // step
    Turtle t2 = new Turtle(5, 4); // step
    Turtle t3 = new Turtle(2, 1); // step

    t1.右を向く(); // step
    t1.右を向く(); // step
    t1.前に進む(); // step

    t2.左を向く(); // step
    t2.左を向く(); // step
    t2.前に進む(); // step

    t3.右を向く(); // step
    t3.前に進む(); // step
    t3.前に進む(); // step
  }
}
`,
  },
  multiObject4: {
    instrumented: `
const t1 = new Turtle(0, 6); // step
const t2 = new Turtle(6, 0); // step

t1.右を向く(); // step
t1.右を向く(); // step

for (s.set('i', 0); s.get('i') < 5; s.set('i', s.get('i') + 1)) {
  t1.前に進む(); // step
  t2.前に進む(); // step
  if (s.get('i') % 2 === 0) {
    t1.左を向く(); // step
    t2.左を向く(); // step
  } else {
    t1.右を向く(); // step
    t2.右を向く(); // step
  }
}
delete s.vars['i'];
`,
    java: `
public class Main {
  public static void main(String[] args) {
    Turtle t1 = new Turtle(0, 6); // step
    Turtle t2 = new Turtle(6, 0); // step

    t1.右を向く(); // step
    t1.右を向く(); // step

    for (int i = 0; i < 5; i++) { // step
      t1.前に進む(); // step
      t2.前に進む(); // step
      if (i % 2 == 0) {
        t1.左を向く(); // step
        t2.左を向く(); // step
      } else {
        t1.右を向く(); // step
        t2.右を向く(); // step
      }
    }
  }
}
`,
  },
  multiObject5: {
    instrumented: `
    const t1 = new Turtle(0, 3); // step
    const t2 = new Turtle(4, 3); // step
    const t3 = new Turtle(0, 0); // step
    const t4 = new Turtle(1, 6); // step
    const t5 = new Turtle(6, 4); // step

    t1.右を向く(); // step

    while (t1.canMoveForward()) {
      while (t1.canMoveForward()) {
        t1.前に進む(); // step
      }
      t1.右を向く(); // step
    }
    `,
    java: `
public class Main {
  public static void main(String[] args) {
    Turtle t1 = new Turtle(0, 3); // step
    Turtle t2 = new Turtle(4, 3); // step
    Turtle t3 = new Turtle(0, 0); // step
    Turtle t4 = new Turtle(1, 6); // step
    Turtle t5 = new Turtle(6, 4); // step

    t1.右を向く(); // step

    while (t1.前に進めるか()) {
      while (t1.前に進めるか()) {
        t1.前に進む(); // step
      }
      t1.右を向く(); // step
    }
  }
}
`,
  },
  multiObject6: {
    instrumented: `
const ts = [null, null, null];
for (s.set('i', 0); s.get('i') < ts.length; s.set('i', s.get('i') + 1)) {
  ts[s.get('i')] = new Turtle(1 + s.get('i') * 2, 0); // step
}
delete s.vars['i'];

for (s.set('i', 0); s.get('i') < 3; s.set('i', s.get('i') + 1)) {
  for (s.set('j', 0); s.get('j') < ts.length; s.set('j', s.get('j') + 1)) {
    N歩前に進める(ts[s.get('j')], s.get('j')); // step
    // call(N歩前に進める, 't', 'n')(ts[s.get('j')], s.get('j')); //caller
  }
}
delete s.vars['i'];
delete s.vars['j'];

function N歩前に進める(t, n) {
  for (let i = 0; i < n; i++) {
    t.前に進む();
  }
}
`,
    java: `
public class Main {
  public static void main(String[] args) {
    Turtle[] turtles = new Turtle[3];
    for (int i = 0; i < turtles.length; i++) { // step
      turtles[i] = new Turtle(1 + i * 2, 0); // step
    }

    for (int i = 0; i < 3; i++) { // step
      for (int j = 0; j < turtles.length; j++) { // step
        N歩前に進める(turtles[j], j); // step
      }
    }
  }

  static void N歩前に進める(Turtle t, int n) {
    for (int i = 0; i < n; i++) {
      t.前に進む();
    }
  }
}
`,
  },
  garbageCollection1: {
    instrumented: `
let t1 = new Turtle(1, 1); // step
t1.前に進む(); // step
t1.右を向く(); // step
let t2 = new Turtle(3, 3); // step
t2.前に進む(); // step
t2.remove(); // step
t2 = t1;
t2.前に進む(); // step
`,
    java: `
public class Main {
  public static void main(String[] args) {
    Turtle t1 = new Turtle(1, 1); // step
    t1.前に進む(); // step
    t1.右を向く(); // step
    Turtle t2 = new Turtle(3, 3); // step
    t2.前に進む(); // step
    // ガベージコレクションで亀が消えることとする。
    t2 = t1; // step
    t2.前に進む(); // step
  }
}
`,
  },
  garbageCollection2: {
    instrumented: `
let t1 = new Turtle(1, 1); // step
let t2 = new Turtle(3, 3); // step
let t3 = new Turtle(5, 5); // step

t1.前に進む(); // step
t2.前に進む(); // step
t3.前に進む(); // step

t2.remove(); // step
t2 = t1;
t3.remove(); // step
t3 = t2;

t3.前に進む(); // step
t2.前に進む(); // step
t1.前に進む(); // step
`,
    java: `
public class Main {
  public static void main(String[] args) {
  Turtle t1 = new Turtle(1, 1); // step
  Turtle t2 = new Turtle(3, 3); // step
  Turtle t3 = new Turtle(5, 5); // step

  t1.前に進む(); // step
  t2.前に進む(); // step
  t3.前に進む(); // step

  // ガベージコレクションで亀が消えることとする。
  t2 = t1; // step
  // ガベージコレクションで亀が消えることとする。
  t3 = t2; // step

  t3.前に進む(); // step
  t2.前に進む(); // step
  t1.前に進む(); // step
  }
}
`,
  },
  garbageCollection3: {
    instrumented: `
const turtles = [];
turtles[0] = new Turtle(2, 3); // step
turtles[1] = new Turtle(3, 4); // step

for (s.set('i', 0); s.get('i') < turtles.length; s.set('i', s.get('i') + 1)) { // step
  call(N回右を向く, 't', 'n')(turtles[s.get('i')], s.get('i')); // step
}
for (s.set('i', 0); s.get('i') < turtles.length; s.set('i', s.get('i') + 1)) { // step
  call(N回前に進む, 't', 'n')(turtles[s.get('i')], 3); // step
}

turtles[0].remove();
turtles[0] = new Turtle(4, 3); // step
turtles[1].remove();
turtles[1] = new Turtle(3, 2); // step

for (s.set('i', 0); s.get('i') < turtles.length; s.set('i', s.get('i') + 1)) { // step
  call(N回左を向く, 't', 'n')(turtles[s.get('i')], s.get('i')); // step
}
for (s.set('i', 0); s.get('i') < turtles.length; s.set('i', s.get('i') + 1)) { // step
  call(N回前に進む, 't', 'n')(turtles[s.get('i')], 3); // step
}

function N回前に進む(t, n) {
  for (let i = 0; i < n; i++) t.前に進む();
}
function N回右を向く(t, n) {
  for (let i = 0; i < n; i++) t.右を向く();
}
function N回左を向く(t, n) {
  for (let i = 0; i < n; i++) t.左を向く();
}
`,
    java: `
public class Main {
  public static void main(String[] args) {
    Turtle[] turtles = new Turtle[2];
    turtles[0] = new Turtle(2, 3); // step
    turtles[1] = new Turtle(3, 4); // step

    for (int i = 0; i < turtles.length; i++) // step
      N回右を向く(turtles[i], i); // step
    for (int i = 0; i < turtles.length; i++) // step
      N回前に進む(turtles[i], 3); // step

    // ガベージコレクションで亀が消えることとする。
    turtles[0] = new Turtle(4, 3); // step
    // ガベージコレクションで亀が消えることとする。
    turtles[1] = new Turtle(3, 2); // step

    for (int i = 0; i < turtles.length; i++) // step
      N回左を向く(turtles[i], i); // step
    for (int i = 0; i < turtles.length; i++) // step
      N回前に進む(turtles[i], 3); // step
  }

  static void N回前に進む(Turtle t, int n) {
    for (int i = 0; i < n; i++) t.前に進む();
  }
  static void N回右を向く(Turtle t, int n) {
    for (int i = 0; i < n; i++) t.右を向く();
  }
  static void N回左を向く(Turtle t, int n) {
    for (int i = 0; i < n; i++) t.左を向く();
  }
}
`,
  },
  garbageCollection4: {
    instrumented: `
const turtles = new Array(5);
for (s.set('i', 0); s.get('i') < turtles.length; s.set('i', s.get('i') + 1)) { // step
  turtles[s.get('i')] = new Turtle(s.get('i'), 0); // step
}

for (s.set('i', 0); s.get('i') < turtles.length; s.set('i', s.get('i') + 1)) { // step
  turtles[s.get('i')].remove(); // step
  turtles[s.get('i')] = null;

  for (const t of turtles) {
    if (t !== null) {
      t.前に進む(); // step
    }
  }
}
`,
    java: `
public class Main {
  public static void main(String[] args) {
    Turtle[] turtles = new Turtle[5];
    for (int i = 0; i < turtles.length; i++) { // step
      turtles[i] = new Turtle(i, 0); // step
    }

    for (int i = 0; i < turtles.length; i++) { // step
      // nullは、何も参照していないことを示す特別な値。
      // ガベージコレクションで亀が消えることとする。
      turtles[i] = null; // step

      for (Turtle t : turtles) {
        if (t != null) {
          t.前に進む(); // step
        }
      }
    }
  }
}
`,
  },
  garbageCollection5: {
    instrumented: `
call(線を描く, 'x', 'y', 'dir', 'len')(1, 1, 1, 5);
call(線を描く, 'x', 'y', 'dir', 'len')(1, 5, 2, 5);
const t = new Turtle(3, 3); // step

function 線を描く(x, y, dir, len) {
  const t = new Turtle(x, y); // step
  for (s.set('i', 0); s.get('i') < dir; s.set('i', s.get('i') + 1)) { // step
    t.右を向く(); // step
  }
  for (s.set('i', 0); s.get('i') < len - 1; s.set('i', s.get('i') + 1)) { // step
    t.前に進む(); // step
  }
  t.remove();
}
`,
    java: `
public class Main {
  public static void main(String[] args) {
    線を描く(1, 1, 1, 5); // caller
    線を描く(1, 5, 2, 5); // caller
    Turtle t = new Turtle(3, 3); // step
  }

  static void 線を描く(int x, int y, int dir, int len) {
    Turtle t = new Turtle(x, y); // step
    for (int i = 0; i < dir; i++) { // step
      t.右を向く(); // step
    }
    for (int i = 0; i < len - 1; i++) { // step
      t.前に進む(); // step
    }
    // 線を描く()メソッドが終わると変数tはなくなり、亀も消えることとする。
  }
}
`,
  },
  garbageCollection6: {
    instrumented: `
call(正方形を描く, 'x', 'y', 'size')(0, 0, 6);
call(正方形を描く, 'x', 'y', 'size')(3, 3, 3);
const t = new Turtle(3, 3); // step

function 正方形を描く(x, y, size) {
  call(線を描く, 'x', 'y', 'dir', 'len')(x, y, 0, size);
  call(線を描く, 'x', 'y', 'dir', 'len')(x, y + size, 1, size);
  call(線を描く, 'x', 'y', 'dir', 'len')(x + size, y + size, 2, size);
  call(線を描く, 'x', 'y', 'dir', 'len')(x + size, y, 3, size);
}

function 線を描く(x, y, dir, len) {
  const t = new Turtle(x, y); // step
  for (let i = 0; i < dir; i++) { // step
    t.右を向く(); // step
  }
  for (let i = 0; i < len - 1; i++) { // step
    t.前に進む(); // step
  }
  t.remove();
}
`,
    java: `
public class Main {
  public static void main(String[] args) {
    正方形を描く(0, 0, 6); // caller
    正方形を描く(3, 3, 3); // caller
    Turtle t = new Turtle(3, 3); // step
  }

  static void 正方形を描く(int x, int y, int size) {
    線を描く(x, y, 0, size); // caller
    線を描く(x, y + size, 1, size); // caller
    線を描く(x + size, y + size, 2, size); // caller
    線を描く(x + size, y, 3, size); // caller
  }

  static void 線を描く(int x, int y, int dir, int len) {
    Turtle t = new Turtle(x, y); // step
    for (int i = 0; i < dir; i++) { // step
      t.右を向く(); // step
    }
    for (int i = 0; i < len - 1; i++) { // step
      t.前に進む(); // step
    }
    // 線を描く()メソッドが終わると変数tはなくなり、亀も消えることとする。
  }
}
`,
  },
  // ----------- 初級プログラミングⅡ 第1回 ここまで -----------

  // ----------- 初級プログラミングⅡ 第2回 ここから -----------
  makeClass1: {
    // 独自クラスを定義するコードでは `main()` 関数を定義すること。
    instrumented: `
function main() {
  const t = call(MyTurtle)();
  call(t.moveForward.bind(t))();
  t.speed = 1; // step
  call(t.moveForward.bind(t))();
}

class MyTurtle {
  constructor() {
    this.t = new Turtle(); // step
    this.speed = 2; // step
  }
  moveForward() {
    for (s.set('i', 0); s.get('i') < this.speed; s.set('i', s.get('i') + 1)) { // step
      this.t.前に進む(); // step
    }
    delete s.vars['i'];
  }
}

main();
    `,
    java: `
public class Main {
  public static void main(String[] args) {
    MyTurtle t = new MyTurtle(); // caller
    t.moveForward(); // caller
    t.speed = 1; // step
    t.moveForward(); // caller
  }
}

class MyTurtle {
  Turtle t = new Turtle(); // step
  int speed = 2; // step

  void moveForward() {
    for (int i = 0; i < this.speed; i++) { // step
      this.t.前に進む(); // step
    }
  }
}
    `,
  },
  makeClass2: {
    instrumented: `
function main() {
  const t = call(MyTurtle)();
  call(t.moveDiagonally.bind(t))();
  t.speed = 2; // step
  call(t.moveDiagonally.bind(t))();
}

class MyTurtle {
  constructor() {
    this.t = new Turtle(); // step
    this.speed = 1; // step
  }
  moveDiagonally() {
    for (s.vars.i = 0; s.vars.i < this.speed; s.vars.i++) { // step
      this.t.前に進む(); // step
      this.t.右を向く(); // step
      this.t.前に進む(); // step
      this.t.左を向く(); // step
    }
    delete s.vars.i;
  }
}

main();
    `,
    java: `
public class Main {
  public static void main(String[] args) {
    MyTurtle t = new MyTurtle(); // caller
    t.moveDiagonally(); // caller
    t.speed = 2; // step
    t.moveDiagonally(); // caller
  }
}

class MyTurtle {
  Turtle t = new Turtle(); // step
  int speed = 1; // step

  void moveDiagonally() {
    for (int i = 0; i < this.speed; i++) { // step
      this.t.前に進む(); // step
      this.t.右を向く(); // step
      this.t.前に進む(); // step
      this.t.左を向く(); // step
    }
  }
}
    `,
  },
  makeClass3: {
    instrumented: `
function main() {
  const t = call(MyTurtle)();
  call(t.drawSquare.bind(t))();
  t.size = 4; // step
  call(t.drawSquare.bind(t))();
}

class MyTurtle {
  constructor() {
    this.t = new Turtle(); // step
    this.size = 2; // step
  }
  drawSquare() {
    for (s.set('i', 0); s.get('i') < this.size * 4; s.set('i', s.get('i') + 1)) { // step
      if (s.get('i') % this.size === this.size - 1) {
        this.t.右を向く(); // step
      } else {
        this.t.前に進む(); // step
      }
    }
    delete s.vars['i'];
  }
}

main();
    `,
    java: `
public class Main {
  public static void main(String[] args) {
    MyTurtle t = new MyTurtle(); // caller
    t.drawSquare(); // caller
    t.size = 4; // step
    t.drawSquare(); // caller
  }
}

class MyTurtle {
  Turtle t = new Turtle(); // step
  int size = 2; // step

  void drawSquare() {
    for (int i = 0; i < this.size * 4; i++) { // step
      if (i % this.size == this.size - 1) {
        this.t.右を向く(); // step
      } else {
        this.t.前に進む(); // step
      }
    }
  }
}
    `,
  },
  makeClass4: {
    instrumented: `
function main() {
  const t = call(MyTurtle)();
  call(t.moveForward.bind(t))();
  t.speed = 1; // step
  call(t.turnRight.bind(t))();
  call(t.moveForward.bind(t))();
}

class MyTurtle {
  constructor() {
    this.fast = new Turtle(1, 1); // step
    this.slow = new Turtle(5, 1); // step
    this.speed = 2; // step
  }
  moveForward() {
    for (s.set('i', 0); s.get('i') < this.speed; s.set('i', s.get('i') + 1)) { // step
      this.fast.前に進む(); // step
	    this.fast.前に進む(); // step
      this.slow.前に進む(); // step
    }
    delete s.vars['i'];
  }
  turnRight() {
    this.fast.右を向く(); // step
    this.slow.右を向く(); // step
  }
}

main();
    `,
    java: `
public class Main {
  public static void main(String[] args) {
    MyTurtle t = new MyTurtle(); // caller
    t.moveForward(); // caller
    t.speed = 1; // step
    t.turnRight(); // caller
    t.moveForward(); // caller
  }
}
class MyTurtle {
  Turtle fast = new Turtle(1, 1); // step
  Turtle slow = new Turtle(5, 1); // step
  int speed = 2; // step

  void moveForward() {
    for (int i = 0; i < this.speed; i++) { // step
      this.fast.前に進む(); // step
      this.fast.前に進む(); // step
      this.slow.前に進む(); // step
    }
  }
  void turnRight() {
    this.fast.右を向く(); // step
    this.slow.右を向く(); // step
  }
}
    `,
  },
  makeClass5: {
    instrumented: `
function main() {
  const t = call(MyTurtle)();
  call(t.operate.bind(t))();
  t.operation = "LFFRFF"; // step
  call(t.operate.bind(t))();
}

class MyTurtle {
  constructor() {
    this.t = new Turtle(); // step
    this.operation = "FFRFF"; // step
  }

  operate() {
    for (s.set('i', 0); s.get('i') < this.operation.length; s.set('i', s.get('i') + 1)) { // step
      switch (this.operation.charAt(s.get('i'))) {
      case 'F':
        this.t.前に進む(); // step
        break;
      case 'R':
        this.t.右を向く(); // step
        break;
      case 'L':
        this.t.左を向く(); // step
        break;
      }
    }
    delete s.vars['i'];
  }
}

main();
`,
    java: `
public class Main {
  public static void main(String[] args) {
    MyTurtle t = new MyTurtle(); //caller
    t.operate(); // caller
    t.operation = "LFFRFF"; // step
    t.operate(); // caller
  }
}
class MyTurtle {
  Turtle t = new Turtle(); // step
  String operation = "FFRFF"; // step

  void operate() {
    for (int i = 0; i < this.operation.length(); i++) { // step
      switch (this.operation.charAt(i)) {
        case 'F':
          this.t.前に進む(); break; // step
        case 'R':
          this.t.右を向く(); break; // step
        case 'L':
          this.t.左を向く(); break; // step
      }
    }
  }
}
`,
  },
  makeClass6: {
    instrumented: `
function main() {
  const t = call(MyTurtle)();
  call(t.turnRight.bind(t))();
  call(t.moveForward.bind(t))();
  call(t.turnLeft.bind(t))();
  call(t.moveForward.bind(t))();
  call(t.moveForward.bind(t))();
}
class MyTurtle {
  constructor() {
    this.t = new Turtle(); // step
    this.speed = 1; // step
  }
  moveForward() {
    for (s.set('i', 0); s.get('i') < this.speed; s.set('i', s.get('i') + 1)) { // step
      this.t.前に進む(); // step
    }
    delete s.vars['i'];
    this.speed++; // step
  }
  turnRight() {
    this.t.右を向く(); // step
  }
  turnLeft() {
    this.t.左を向く(); // step
  }
}

main();
`,
    java: `
public class Main {
  public static void main(String[] args) {
    MyTurtle t = new MyTurtle(); // caller
    t.turnRight(); // caller
    t.moveForward(); // caller
    t.turnLeft(); // caller
    t.moveForward(); // caller
    t.moveForward(); // caller
  }
}
class MyTurtle {
  Turtle t = new Turtle(); // step
  int speed = 1; // step
  void moveForward() {
    for (int i = 0; i < this.speed; i++) // step
      this.t.前に進む(); // step
    speed++; // step
  }
  void turnRight() {
    this.t.右を向く(); // step
  }
  void turnLeft() {
    this.t.左を向く(); // step
  }
}
`,
  },
  constructor1: {
    instrumented: `
function main() {
  const t = call(MyTurtle, 'x', 'y', 'speed')(0, 1, 2);
  call(t.moveForward.bind(t))();
  t.speed = 1; // step
  call(t.moveForward.bind(t))();
}

class MyTurtle {
  constructor(x, y, speed) {
    this.t = new Turtle(x, y); // step
    this.speed = speed; // step
  }
  moveForward() {
    for (s.set('i', 0); s.get('i') < this.speed; s.set('i', s.get('i') + 1)) { // step
      this.t.前に進む(); // step
    }
    delete s.vars['i'];
  }
}

main();
    `,
    java: `
public class Main {
  public static void main(String[] args) {
    MyTurtle t = new MyTurtle(0, 1, 2); // caller
    t.moveForward(); // caller
    t.speed = 1; // step
    t.moveForward(); // caller
  }
}

class MyTurtle {
  Turtle t;
  int speed;

  MyTurtle(int x, int y, int speed) {
    this.t = new Turtle(x, y); // step
    this.speed = speed; // step
  }
  void moveForward() {
    for (int i = 0; i < this.speed; i++) { // step
      this.t.前に進む(); // step
    }
  }
}
    `,
  },
  constructor2: {
    instrumented: `
function main() {
  const t = call(MyTurtle, 'x', 'y', 'operation')(1, 1, "FRFLFFF");
  call(t.operate.bind(t))();
}
class MyTurtle {
  constructor(x, y, operation) {
    this.t = new Turtle(x, y); // step
    this.operation = operation; // step
  }
  operate() {
    for (s.set('i', 0); s.get('i') < this.operation.length; s.set('i', s.get('i') + 1)) { // step
      switch (this.operation.charAt(s.get('i'))) {
      case 'F':
        this.t.前に進む(); // step
        break;
      case 'R':
        this.t.右を向く(); // step
        break;
      case 'L':
        this.t.左を向く(); // step
        break;
      }
    }
    delete s.vars['i'];
  }
}

main();
`,
    java: `
public class Main {
  public static void main(String[] args) {
    MyTurtle t = new MyTurtle(1, 1, "FRFLFFF"); // caller
    t.operate(); // caller
  }
}
class MyTurtle {
  Turtle t;
  String operation;

  MyTurtle(int x, int y, String operation) {
    this.t = new Turtle(x, y); // step
    this.operation = operation; // step
  }
  void operate() {
    for (int i = 0; i < this.operation.length(); i++) { // step
      switch (this.operation.charAt(i)) {
      case 'F':
        this.t.前に進む(); break; // step
      case 'R':
        this.t.右を向く(); break; // step
      case 'L':
        this.t.左を向く(); break; // step
      }
    }
  }
}
`,
  },
  constructor3: {
    instrumented: `
function main() {
  const t = call(MyTurtle, 'speed')(2);
  call(t.moveForward.bind(t))();
  call(t.turnRight.bind(t))();
  call(t.moveForward.bind(t))();
  call(t.moveForward.bind(t))();
  call(t.turnLeft.bind(t))();
}
class MyTurtle {
  constructor(speed) {
    this.t = new Turtle(); // step
    this.speed = speed; // step
  }
  moveForward() {
    for (s.set('i', 0); s.get('i') < this.speed; s.set('i', s.get('i') + 1)) { // step
      this.t.前に進む(); // step
    }
    delete s.vars['i'];
    this.speed--; // step
  }
  turnRight() {
    this.t.右を向く(); // step
  }
  turnLeft() {
    this.t.左を向く(); // step
  }
}

main();
`,
    java: `
public class Main {
  public static void main(String[] args) {
    MyTurtle t = new MyTurtle(2); // caller
    t.moveForward(); // caller
    t.turnRight(); // caller
    t.moveForward(); // caller
    t.moveForward(); // caller
    t.turnLeft(); // caller
  }
}
class MyTurtle {
  Turtle t;
  int speed;

  MyTurtle(int speed) {
    this.t = new Turtle(); // step
    this.speed = speed; // step
  }
  void moveForward() {
    for (int i = 0; i < this.speed; i++) // step
      this.t.前に進む(); // step
    this.speed--; // step
  }
  void turnRight() {
    this.t.右を向く(); // step
  }
  void turnLeft() {
    this.t.左を向く(); // step
  }
}
`,
  },
  constructor4: {
    instrumented: `
function main() {
  const t1 = new Turtle(3, 4); // step
  const t2 = new Turtle(0, 0); // step
  const mover = call(TurtleMover, 't')(t1);
  call(mover.moveSquare.bind(mover), 'size')(3);
  mover.t = new Turtle(3, 1); // step
  call(mover.moveSquare.bind(mover), 'size')(3);
  mover.t.remove();
  mover.t = t2; // step
  call(mover.moveSquare.bind(mover), 'size')(2);
}
class TurtleMover {
  constructor(t) {
    this.t = t; // step
  }
  moveSquare(size) {
    for (s.set('i', 0); s.get('i') < size * 4; s.set('i', s.get('i') + 1)) { // step
      if (s.get('i') % size === size - 1) {
        this.t.右を向く(); // step
      } else {
        this.t.前に進む(); // step
      }
    }
    delete s.vars['i'];
  }
}

main();
`,
    java: `
public class Main {
  public static void main(String[] args) {
    Turtle t1 = new Turtle(3, 4); // step
    Turtle t2 = new Turtle(0, 0); // step
    TurtleMover mover = new TurtleMover(t1); // caller
    mover.moveSquare(3); // caller
    mover.t = new Turtle(3, 1); // step
    mover.moveSquare(3); // caller
    mover.t = t2; // ガベージコレクションで亀が消えることとする。 // step
    mover.moveSquare(2); // caller
  }
}
class TurtleMover {
  Turtle t;

  TurtleMover(Turtle t) {
    this.t = t; // step
  }
  void moveSquare(int size) {
    for (int i = 0; i < size * 4; i++) { // step
      if (i % size == size - 1) {
        this.t.右を向く(); // step
      } else {
        this.t.前に進む(); // step
      }
    }
  }
}
`,
  },
  // ----------- 初級プログラミングⅡ 第2回 ここまで -----------

  // ----------- 初級プログラミングⅡ 第3回 ここから -----------
  encapsulation: {
    // 独自クラスを定義するコードでは `main()` 関数を定義すること。
    instrumented: `
function main() {
  const t = call(MyTurtle)();
  call(t.moveForward.bind(t))();
  call(t.changeSpeed.bind(t), 'speed')(1);
  call(t.moveForward.bind(t))();
}

class MyTurtle {
  constructor() {
    this.t = new Turtle(); // step
    this.speed = 2; // step
  }

  moveForward() {
    for (s.set('i', 0); s.get('i') < this.speed; s.set('i', s.get('i') + 1)) { // step
      this.t.前に進む(); // step
    }
    delete s.vars['i'];
  }
  changeSpeed(speed) {
    this.speed = speed; // step
  }
}

main();
`,
    java: `
public class Main {
  public static void main(String[] args) {
    MyTurtle t = new MyTurtle(); // caller
    t.moveForward(); // caller
    t.changeSpeed(1); // caller
    t.moveForward(); // caller
  }
}

class MyTurtle {
  private Turtle t = new Turtle(); // step
  private int speed = 2; // step

  public void moveForward() {
    for (int i = 0; i < this.speed; i++) { // step
      this.t.前に進む(); // step
    }
  }
  public void changeSpeed(int speed) {
    this.speed = speed; // step
  }
}
`,
  },
  withoutEncapsulation: {
    instrumented: `
const t = new Turtle(); // step
call(drawSquare, 't', 'size')(t, 2);
call(drawSquare, 't', 'size')(t, 3);

function drawSquare(t, size) {
  for (s.set('i', 0); s.get('i') < 4; s.set('i', s.get('i') + 1)) {
    for (s.set('j', 0); s.get('j') < size - 1; s.set('j', s.get('j') + 1)) {
      t.前に進む(); // step
    }
    delete s.vars['j'];
    t.右を向く(); // step
  }
  delete s.vars['i'];
}
`,
    java: `
public class Main {
  public static void main(String[] args) {
    Turtle t = new Turtle(); // step
    drawSquare(t, 2); // caller
    drawSquare(t, 3); // caller
  }

  static void drawSquare(Turtle t, int size) {
    for (int i = 0; i < 4; i++) { // step
      for (int j = 0; j < size - 1; j++) { // step
        t.前に進む(); // step
      }
      t.右を向く(); // step
    }
  }
}
`,
  },
  withEncapsulation: {
    // 独自クラスを定義するコードでは `main()` 関数を定義すること。
    instrumented: `
function main() {
  const t = call(SquareTurtle)();
  call(t.draw.bind(t), 'size')(2);
  call(t.draw.bind(t), 'size')(3);
}

class SquareTurtle {
  constructor() {
    this.t = new Turtle(0, 0); // step
  }
  draw(size) {
    for (s.set('i', 0); s.get('i') < 4; s.set('i', s.get('i') + 1)) { // step
      for (s.set('j', 0); s.get('j') < size - 1; s.set('j', s.get('j') + 1)) { // step
        this.t.前に進む(); // step
      }
      delete s.vars['j'];
      this.t.右を向く(); // step
    }
    delete s.vars['i'];
  }
}

main();
`,
    java: `
public class Main {
  public static void main(String[] args) {
    SquareTurtle t = new SquareTurtle(); // caller
    t.draw(2); // caller
    t.draw(3); // caller
  }
}

class SquareTurtle {
  private Turtle t = new Turtle(0, 0); // step

  void draw(int size) {
    for (int i = 0; i < 4; i++) { // step
      for (int j = 0; j < size - 1; j++) { // step
        this.t.前に進む(); // step
      }
      this.t.右を向く(); // step
    }
  }
}
`,
  },
  withoutEncapsulation2: {
    instrumented: `
const t = new Turtle(); // step
call(drawCurve, 't', 'speed')(t, 3);

function drawCurve(t, speed) {
  call(drawLine, 't', 'speed')(t, speed);
  t.右を向く(); // step
  call(drawLine, 't', 'speed')(t, speed);
}
function drawLine(t, speed) {
  for (s.set('i', 0); s.get('i') < speed; s.set('i', s.get('i') + 1)) { // step
    t.前に進む(); // step
  }
  delete s.vars['i'];
}
`,
    java: `
public class Main {
  public static void main(String[] args) {
    Turtle t = new Turtle(); // step
    drawCurve(t, 3); // caller
  }
  static void drawCurve(Turtle t, int speed) {
    drawLine(t, speed); // caller
    t.右を向く(); // step
    drawLine(t, speed); // caller
  }
  static void drawLine(Turtle t, int speed) {
    for (int i = 0; i < speed; i++) { // step
      t.前に進む(); // step
    }
  }
}
`,
  },
  withEncapsulation2: {
    instrumented: `
function main() {
  const t = call(CurveTurtle)();
  call(t.draw.bind(t),'speed')(2);
}
class CurveTurtle {
  constructor() {
    this.t = new Turtle(); // step
  }
  draw(speed) {
    call(this.drawLine.bind(this), 'speed')(speed);
    this.t.右を向く(); // step
    call(this.drawLine.bind(this), 'speed')(speed);
  }
  drawLine(speed) {
    for (s.set('i', 0); s.get('i') < speed; s.set('i', s.get('i') + 1)) { // step
      this.t.前に進む(); // step
    }
    delete s.vars['i'];
  }
}
main();
`,
    java: `
public class Main {
  public static void main(String[] args) {
    CurveTurtle t = new CurveTurtle(); // caller
    t.draw(2); // caller
  }
}
class CurveTurtle {
  private Turtle t = new Turtle(0, 0); // step
  void draw(int speed) {
    this.drawLine(speed); // caller
    this.t.右を向く(); // step
    this.drawLine(speed); // caller
  }
  void drawLine(int speed) {
    for (int i = 0; i < speed; i++) { // step
      this.t.前に進む(); // step
    }
  }
}
`,
  },
  withEncapsulation3: {
    instrumented: `
function main() {
  let t = call(MyTurtle, 'x', 'y', 'speed')(0, 0, 1);
  call(t.moveForward.bind(t))();
  call(t.moveForward.bind(t))();
  t.t.remove();
  t = call(MyTurtle, 'x', 'y', 'speed')(2, 2, t.getSpeed() * 2);
  call(t.moveForward.bind(t))();
}
class MyTurtle {
  constructor(x, y, speed) {
    this.t = new Turtle(x, y); // step
    this.speed = speed; // step
  }
  getSpeed() {
    return this.speed;
  }
  moveForward() {
    for (s.set('i', 0); s.get('i') < this.speed; s.set('i', s.get('i') + 1)) { // step
      this.t.前に進む(); // step
    }
    delete s.vars['i'];
  }
}
main();
`,
    java: `
public class Main {
  public static void main(String[] args) {
    MyTurtle t = new MyTurtle(0, 0, 1); // caller
    t.moveForward(); // caller
    t.moveForward(); // caller
    // 以下ではガベージコレクションで亀が消えることとする。
    t = new MyTurtle(2, 2, t.getSpeed() * 2); // caller
    t.moveForward(); // caller
  }
}

class MyTurtle {
  private Turtle t;
  private int speed;

  MyTurtle(int x, int y, int speed) {
    this.t = new Turtle(x, y); // step
    this.speed = speed; // step
  }
  public int getSpeed() {
    return this.speed;
  }
  public void moveForward() {
    for (int i = 0; i < this.speed; i++) { // step
      this.t.前に進む(); // step
    }
  }
}
`,
  },
  withEncapsulation4: {
    instrumented: `
function main() {
  const t = call(MyTurtle, 'x', 'y', 'speed')(0, 0, 2);
  call(t.moveForward.bind(t))();
  call(t.setSpeed.bind(t), 'speed')(Math.floor(t.getSpeed() * 3 / 2));
  call(t.moveForward.bind(t))();
  call(t.setSpeed.bind(t), 'speed')(-1);
  call(t.moveForward.bind(t))();
  call(t.setSpeed.bind(t), 'speed')(99);
  call(t.moveBackward.bind(t))();
}
class MyTurtle {
  constructor(x, y, speed) {
    this.t = new Turtle(x, y); // step
    call(this.setSpeed.bind(this), 'speed')(speed);
  }
  getSpeed() {
    return this.speed;
  }
  setSpeed(speed) {
    if (speed < 0) {
      this.speed = 0; // step
    } else if (5 < speed) {
      this.speed = 5; // step
    } else {
      this.speed = speed; // step
    }
  }
  moveForward() {
    for (s.set('i', 0); s.get('i') < this.speed; s.set('i', s.get('i') + 1)) { // step
      this.t.前に進む(); // step
    }
    delete s.vars['i'];
  }
  moveBackward() {
    for (s.set('i', 0); s.get('i') < this.speed; s.set('i', s.get('i') + 1)) { // step
      this.t.後に戻る(); // step
    }
    delete s.vars['i'];
  }
}
main();
`,
    java: `
public class Main {
  public static void main(String[] args) {
    MyTurtle t = new MyTurtle(0, 0, 2); // caller
    t.moveForward(); // caller
    t.setSpeed(t.getSpeed() * 3 / 2); // caller
    t.moveForward(); // caller
    t.setSpeed(-1); // caller
    t.moveForward(); // caller
    t.setSpeed(99); // caller
    t.moveBackward(); // caller
  }
}

class MyTurtle {
  private Turtle t;
  private int speed;

  MyTurtle(int x, int y, int speed) {
    this.t = new Turtle(x, y); // step
    this.setSpeed(speed); // caller
  }
  public int getSpeed() {
    return this.speed;
  }
  public void setSpeed(int speed) {
    if (speed < 0)      this.speed = 0; // step
    else if (5 < speed) this.speed = 5; // step
    else                this.speed = speed; // step
  }
  public void moveForward() {
    for (int i = 0; i < this.speed; i++) // step
      this.t.前に進む(); // step
  }
  public void moveBackward() {
    for (int i = 0; i < this.speed; i++) // step
      this.t.後に戻る(); // step
  }
}
`,
  },
  withEncapsulation5: {
    instrumented: `
function main() {
  const t = call(MyTurtle, 'x', 'y', 'speed')(3, 0, 3);
  call(t.moveForward.bind(t))();
  call(t.changeSpeed.bind(t), 'speed')(-2);
  call(t.moveForward.bind(t))();
  call(t.changeSpeed.bind(t), 'speed')(5);
  call(t.moveForward.bind(t))();
}
class MyTurtle {
  constructor(x, y, speed) {
    this.t = new Turtle(x, y); // step
    this.speed = speed; // step
  }
  moveForward() {
    for (s.set('i', 0); s.get('i') < Math.abs(this.speed); s.set('i', s.get('i') + 1)) { // step
      this.t.前に進む(); // step
    }
    delete s.vars['i'];
  }
  changeSpeed(speed) {
    if (this.speed * speed < 0) {
      this.t.右を向く(); // step
      this.t.右を向く(); // step
    }
    this.speed = speed; // step
  }
}
main();
`,
    java: `
public class Main {
  public static void main(String[] args) {
    MyTurtle t = new MyTurtle(3, 0, 3); // caller
    t.moveForward(); // caller
    t.changeSpeed(-2); // caller
    t.moveForward(); // caller
    t.changeSpeed(5); // caller
    t.moveForward(); // caller
  }
}

class MyTurtle {
  private Turtle t;
  private int speed;

  MyTurtle(int x, int y, int speed) {
    this.t = new Turtle(x, y); // step
    this.speed = speed; // step
  }
  public void moveForward() {
    // Math.abs(this.speed)は、this.speedの絶対値を返す。
    for (int i = 0; i < Math.abs(this.speed); i++) { // step
      this.t.前に進む(); // step
    }
  }
  public void changeSpeed(int speed) {
    if (this.speed * speed < 0) {
      this.t.右を向く(); // step
      this.t.右を向く(); // step
    }
    this.speed = speed; // step
  }
}
`,
  },
  withEncapsulation6: {
    instrumented: `
function main() {
  const t = call(MyTurtle, 'x', 'y')(3, 3);
  call(t.moveForward.bind(t))();
  call(t.moveForward.bind(t))();
  call(t.teleport.bind(t), 'x', 'y')(0, 0);
  call(t.moveForward.bind(t))();
  call(t.teleport.bind(t), 'x', 'y')(6, 6);
}
class MyTurtle {
  constructor(x, y) {
    this.t = new Turtle(x, y); // step
  }
  moveForward() {
    this.t.前に進む(); // step
  }
  teleport(x, y) {
    this.t.remove();
    this.t = new Turtle(x, y); // step
  }
}
main();
`,
    java: `
public class Main {
  public static void main(String[] args) {
    MyTurtle t = new MyTurtle(3, 3); // caller
    t.moveForward(); // caller
    t.moveForward(); // caller
    t.teleport(0, 0); // caller
    t.moveForward(); // caller
    t.teleport(6, 6); // caller
  }
}

class MyTurtle {
  private Turtle t;

  MyTurtle(int x, int y) {
    this.t = new Turtle(x, y); // step
  }
  public void moveForward() {
    this.t.前に進む(); // step
  }
  public void teleport(int x, int y) {
    // ガベージコレクションで元々の亀が消えることとする。
    this.t = new Turtle(x, y); // step
  }
}
`,
  },
  withEncapsulation7: {
    instrumented: `
function main() {
  const t = call(MyTurtle, 'x', 'y')(0, 0);
  call(t.setOperation.bind(t), 'op')("FFRFR");
  call(t.operate.bind(t))();

  call(t.setOperation.bind(t), 'op')("ABC");
  call(t.operate.bind(t))();
}

class MyTurtle {
  constructor(x, y) {
    this.t = new Turtle(x, y); // step
    this.operation = "F"; // step
  }
  setOperation(op) {
    this.operation = op; // step
  }
  operate() {
    for (s.set('i', 0); s.get('i') < this.operation.length; s.set('i', s.get('i') + 1)) { // step
      switch (this.operation.charAt(s.get('i'))) {
        case 'F':
          this.t.前に進む(); // step
          break;
        case 'B':
          this.t.後に戻る(); // step
          break;
        case 'R':
          this.t.右を向く(); // step
          break;
        case 'L':
          this.t.左を向く(); // step
          break;
      }
    }
    delete s.vars['i'];
  }
}

main();

`,
    java: `
public class Main {
  public static void main(String[] args) {
    MyTurtle t = new MyTurtle(0, 0); // caller
    t.setOperation("FFRFR"); // caller
    t.operate(); // caller
    t.setOperation("ABC"); // caller
    t.operate(); // caller
  }
}
class MyTurtle {
  private Turtle t;
  private String operation;

  MyTurtle(int x, int y) {
    this.t = new Turtle(x, y); // step
    this.operation = "F"; // step
  }
  public void setOperation(String op) {
    this.operation = op; // step
  }
  public void operate() {
    for (int i = 0; i < this.operation.length(); i++) { // step
      switch (this.operation.charAt(i)) {
        case 'F':
          this.t.前に進む(); break; // step
        case 'B':
          this.t.後に戻る(); break; // step
        case 'R':
          this.t.右を向く(); break; // step
        case 'L':
          this.t.左を向く(); break; // step
      }
    }
  }
}
`,
  },
  // ----------- 初級プログラミングⅡ 第3回 ここまで -----------

  // ----------- 初級プログラミングⅡ 第4回 ここから -----------
  staticMethod1: {
    // 静的メソッドは普通の関数で代替すること。
    instrumented: `
const t1 = new Turtle(1, 1); // step
call(moveTwoSteps, 't')(t1);
const t2 = new Turtle(3, 3); // step
call(moveTwoSteps, 't')(t2);

function moveTwoSteps(t) {
  t.前に進む(); // step
  t.前に進む(); // step
}
  `,
    java: `
public class Main {
  public static void main(String[] args) {
    Turtle t1 = new Turtle(1, 1); // step
    Controller.moveTwoSteps(t1); // caller
    Turtle t2 = new Turtle(3, 3); // step
    Controller.moveTwoSteps(t2); // caller
  }
}

class Controller {
  static void moveTwoSteps(Turtle t) {
    t.前に進む(); // step
    t.前に進む(); // step
  }
}
    `,
  },
  staticMethod2: {
    // 静的メソッドは普通の関数で代替すること。
    instrumented: `
const t1 = new Turtle(1, 1); // step
const t2 = new Turtle(3, 3); // step
call(moveTwoSteps, 't')(t1);
call(moveTwoSteps, 't')(t2);
t1.前に進む(); // step

function moveTwoSteps(t) {
  t.前に進む(); // step
  t.前に進む(); // step
}
  `,
    java: `
public class Main {
  public static void main(String[] args) {
    Turtle t1 = new Turtle(1, 1); // step
    Turtle t2 = new Turtle(3, 3); // step
    Controller.moveTwoSteps(t1); // caller
    Controller.moveTwoSteps(t2); // caller
    t1.前に進む(); // step
  }
}

class Controller {
  static void moveTwoSteps(Turtle t) {
    t.前に進む(); // step
    t.前に進む(); // step
  }
}
    `,
  },
  staticMethod3: {
    instrumented: `
const t1 = new Turtle(0, 0); // step
call(moveThreeSteps, 't')(t1);
const t2 = new Turtle(3, 0); // step
const t3 = new Turtle(6, 0); // step
call(moveThreeSteps, 't')(t2);
call(moveThreeSteps, 't')(t3);

function moveThreeSteps(t) {
  t.前に進む(); // step
  t.前に進む(); // step
  t.前に進む(); // step
}
    `,
    java: `
public class Main {
    public static void main(String[] args) {
    Turtle t1 = new Turtle(0, 0); // step
    Controller.moveThreeSteps(t1); // caller
    Turtle t2 = new Turtle(3, 0); // step
    Turtle t3 = new Turtle(6, 0); // step
    Controller.moveThreeSteps(t2); // caller
    Controller.moveThreeSteps(t3); // caller
  }
}

class Controller {
  static void moveThreeSteps(Turtle t) {
    t.前に進む(); // step
    t.前に進む(); // step
    t.前に進む(); // step
  }
}
    `,
  },
  staticMethod4: {
    instrumented: `
const t1 = new Turtle(0, 0); // step
const t2 = new Turtle(1, 1); // step
call(drawSquare, 't', 'size')(t1, 4);
const t3 = new Turtle(2, 2); // step
call(drawSquare, 't', 'size')(t2, 3);
call(drawSquare, 't', 'size')(t3, 2);

function drawSquare(t, size) {
  for (s.set('i', 0); s.get('i') < 4; s.set('i', s.get('i') + 1)) { // step
    call(drawLine, 't', 'n')(t, size - 1);
    t.右を向く(); // step
  }
  delete s.vars['i'];
}

function drawLine(t, n) {
  for (s.set('i', 0); s.get('i') < n; s.set('i', s.get('i') + 1)) { // step
    t.前に進む(); // step
  }
  delete s.vars['i'];
}
    `,
    java: `
public class Main {
  public static void main(String[] args) {
    Turtle t1 = new Turtle(0, 0); // step
    Turtle t2 = new Turtle(1, 1); // step
    Controller.drawSquare(t1, 4); // caller
    Turtle t3 = new Turtle(2, 2); // step
    Controller.drawSquare(t2, 3); // caller
    Controller.drawSquare(t3, 2); // caller
  }
}

class Controller {
  static void drawSquare(Turtle t, int size) {
    for (int i = 0; i < 4; i++) { // step
      Controller.drawLine(t, size - 1); // caller
      t.右を向く(); // step
    }
  }
  static void drawLine(Turtle t, int n) {
    for (int i = 0; i < n; i++) // step
      t.前に進む(); // step
  }
}
    `,
  },
  staticField1: {
    instrumented: `
myGlobal.Controller = { stepCount: 0 };

function main() {
  const t1 = new Turtle(1, 1); // step
  call(moveTwoSteps, 't')(t1);
  const t2 = new Turtle(3, 3); // step
  call(moveTwoSteps, 't')(t2);
  s.set('count', myGlobal.Controller.stepCount); // step
}

function moveTwoSteps(t) {
  t.前に進む(); // step
  myGlobal.Controller.stepCount++; // step
  t.前に進む(); // step
  myGlobal.Controller.stepCount++; // step
}

main();
  `,
    java: `
public class Main {
  public static void main(String[] args) {
    Turtle t1 = new Turtle(1, 1); // step
    Controller.moveTwoSteps(t1); // caller
    Turtle t2 = new Turtle(3, 3); // step
    Controller.moveTwoSteps(t2); // caller
    int count = Controller.stepCount; // step
  }
}

class Controller {
  static int stepCount;

  static void moveTwoSteps(Turtle t) {
    t.前に進む(); // step
    stepCount++; // step
    t.前に進む(); // step
    stepCount++; // step
  }
}
    `,
  },
  staticField2: {
    instrumented: `
myGlobal.Settings = { speed: 3 };

function main() {
  const t1 = call(MyTurtle)();
  call(t1.moveForward.bind(t1))();
  myGlobal.Settings.speed = 2; // step
  const t2 = call(MyTurtle)();
  call(t1.moveForward.bind(t1))();
  call(t2.moveForward.bind(t2))();
}

class MyTurtle {
  constructor() {
    this.t = new Turtle(); // step
  }
  moveForward() {
    for (s.set('i', 0); s.get('i') < myGlobal.Settings.speed; s.set('i', s.get('i') + 1)) { // step
      this.t.前に進む(); // step
    }
    delete s.vars['i'];
  }
}

main();
`,
    java: `
public class Main {
  public static void main(String[] args) {
    MyTurtle t1 = new MyTurtle(); // caller
    t1.moveForward(); // caller
    Settings.speed = 2; // step
    MyTurtle t2 = new MyTurtle(); // caller
    t1.moveForward(); // caller
    t2.moveForward(); // caller
  }
}

class Settings {
  static public int speed = 3;
}

class MyTurtle {
  private Turtle t = new Turtle(); // step

  void moveForward() {
    for (int i = 0; i < Settings.speed; i++) { // step
      this.t.前に進む(); // step
    }
  }
}
`,
  },
  staticField3: {
    instrumented: `
myGlobal.Settings = { speed: 2 };

function main() {
  const t1 = call(LineTurtle)();
  const t2 = call(SquareTurtle)();
  call(t1.drawLine.bind(t1))();
  call(t2.drawSquare.bind(t2))();
  myGlobal.Settings.speed = 3; // step
  call(t1.drawLine.bind(t1))();
}

class LineTurtle {
  constructor() {
    this.t = new Turtle(0, 0); // step
  }
  drawLine() {
    for (s.set('i', 0); s.get('i') < myGlobal.Settings.speed; s.set('i', s.get('i') + 1)) { // step
      this.t.前に進む(); // step
    }
    delete s.vars['i'];
  }
}

class SquareTurtle {
  constructor() {
    this.t = new Turtle(1, 1); // step
  }
  drawSquare() {
    for (s.set('i', 0); s.get('i') < 4; s.set('i', s.get('i') + 1)) { // step
      for (s.set('j', 0); s.get('j') < myGlobal.Settings.speed; s.set('j', s.get('j') + 1)) { // step
        this.t.前に進む(); // step
      }
      delete s.vars['j'];
      this.t.右を向く(); // step
    }
    delete s.vars['i'];
  }
}

main();
    `,
    java: `
public class Main {
  public static void main(String[] args) {
    LineTurtle t1 = new LineTurtle(); // caller
    SquareTurtle t2 = new SquareTurtle(); // caller
    t1.drawLine(); // caller
    t2.drawSquare(); // caller
    Settings.speed = 3; // step
    t1.drawLine(); // caller
  }
}
class Settings {
  static public int speed = 2;
}
class LineTurtle {
  private Turtle t = new Turtle(0, 0); // step
  void drawLine() {
    for (int i = 0; i < Settings.speed; i++) // step
      t.前に進む(); // step
  }
}
class SquareTurtle {
  private Turtle t = new Turtle(1, 1); // step
  void drawSquare() {
    for (int i = 0; i < 4; i++) { // step
      for (int j = 0; j < Settings.speed; j++) // step
        t.前に進む(); // step
      t.右を向く(); // step
    }
  }
}
    `,
  },
  staticField4: {
    instrumented: `
myGlobal.Settings = { speed: 2 };

function main() {
  const t1 = call(AcceleratedTurtle)();
  const t2 = call(SquareTurtle)();
  call(t1.drawLine.bind(t1))();
  call(t2.drawSquare.bind(t2))();
  myGlobal.Settings.speed = 2; // step
  call(t1.drawLine.bind(t1))();
}

class AcceleratedTurtle {
  constructor() {
    this.t = new Turtle(0, 0); // step
  }
  drawLine() {
    for (s.set('i', 0); s.get('i') < myGlobal.Settings.speed; s.set('i', s.get('i') + 1)) { // step
      this.t.前に進む(); // step
    }
    delete s.vars['i'];
    myGlobal.Settings.speed++; // step
  }
}

class SquareTurtle {
  constructor() {
    this.t = new Turtle(1, 1); // step
  }
  drawSquare() {
    for (s.set('i', 0); s.get('i') < 4; s.set('i', s.get('i') + 1)) { // step
      for (s.set('j', 0); s.get('j') < myGlobal.Settings.speed; s.set('j', s.get('j') + 1)) { // step
        this.t.前に進む(); // step
      }
      delete s.vars['j'];
      this.t.右を向く(); // step
    }
    delete s.vars['i'];
  }
}

main();
    `,
    java: `
public class Main {
  public static void main(String[] args) {
    AcceleratedTurtle t1 = new AcceleratedTurtle(); // caller
    SquareTurtle t2 = new SquareTurtle(); // caller
    t1.drawLine(); // caller
    t2.drawSquare(); // caller
    Settings.speed = 2; // step
    t1.drawLine(); // caller
  }
}
class Settings {
  static public int speed = 2;
}
class AcceleratedTurtle {
  private Turtle t = new Turtle(0, 0); // step
  void drawLine() {
    for (int i = 0; i < Settings.speed; i++) // step
      t.前に進む(); // step
    Settings.speed++; // step
  }
}
class SquareTurtle {
  private Turtle t = new Turtle(1, 1); // step
  void drawSquare() {
    for (int i = 0; i < 4; i++) { // step
      for (int j = 0; j < Settings.speed; j++) // step
        t.前に進む(); // step
      t.右を向く(); // step
    }
  }
}
    `,
  },
  staticField5: {
    instrumented: `
myGlobal.Settings = { additionalSpeed: 0 };

function main() {
  const t1 = call(SlowTurtle)();
  const t2 = call(FastTurtle)();
  call(t1.moveForward.bind(t1))();
  call(t2.moveForward.bind(t2))();
  myGlobal.Settings.additionalSpeed++; // step
  call(t1.moveForward.bind(t1))();
  call(t2.moveForward.bind(t2))();
}

class SlowTurtle {
  constructor() {
    this.t = new Turtle(0, 0); // step
    this.base = 1; // step
  }
  moveForward() {
    for (s.set('i', 0); s.get('i') < this.base + myGlobal.Settings.additionalSpeed; s.set('i', s.get('i') + 1)) { // step
      this.t.前に進む(); // step
    }
    delete s.vars['i'];
  }
}

class FastTurtle {
  constructor() {
    this.t = new Turtle(6, 0); // step
    this.base = 2; // step
  }
  moveForward() {
    for (s.set('i', 0); s.get('i') < this.base + myGlobal.Settings.additionalSpeed; s.set('i', s.get('i') + 1)) { // step
      this.t.前に進む(); // step
    }
    delete s.vars['i'];
  }
}

main();
    `,
    java: `
public class Main {
  public static void main(String[] args) {
    SlowTurtle t1 = new SlowTurtle(); // caller
    FastTurtle t2 = new FastTurtle(); // caller
    t1.moveForward(); // caller
    t2.moveForward(); // caller
    Settings.additionalSpeed++; // step
    t1.moveForward(); // caller
    t2.moveForward(); // caller
  }
}
class Settings {
  static public int additionalSpeed = 0;
}
class SlowTurtle {
  private Turtle t = new Turtle(0, 0); // step
  private int base = 1; // step
  void moveForward() {
    for (int i = 0; i < this.base + Settings.additionalSpeed; i++) // step
      t.前に進む(); // step
  }
}
class FastTurtle {
  private Turtle t = new Turtle(6, 0); // step
  private int base = 2; // step
  void moveForward() {
    for (int i = 0; i < this.base + Settings.additionalSpeed; i++) // step
      t.前に進む(); // step
  }
}
    `,
  },
  staticField6: {
    instrumented: `
myGlobal.Settings = { additionalSpeed: 0 };

function main() {
  const t1 = call(MyTurtle, 'x', 'y')(0, 0);
  const t2 = call(MyTurtle, 'x', 'y')(3, 0);
  call(t1.moveForward.bind(t1))();
  call(t2.moveForward.bind(t2))();
  t1.base++; // step
  myGlobal.Settings.additionalSpeed++; // step
  call(t1.moveForward.bind(t1))();
  call(t2.moveForward.bind(t2))();
}

class MyTurtle {
  constructor(x, y) {
    this.turtle = new Turtle(x, y); // step
    this.base = 1; // step
  }
  moveForward() {
    for (s.set('i', 0); s.get('i') < this.base + myGlobal.Settings.additionalSpeed; s.set('i', s.get('i') + 1)) { // step
      this.turtle.前に進む(); // step
    }
    delete s.vars['i'];
  }
}

main();
    `,
    java: `
public class Main {
  public static void main(String[] args) {
    MyTurtle t1 = new MyTurtle(0, 0); // caller
    MyTurtle t2 = new MyTurtle(3, 0); // caller
    t1.moveForward(); // caller
    t2.moveForward(); // caller
    t1.base++; // step
    Settings.additionalSpeed++; // step
    t1.moveForward(); // caller
    t2.moveForward(); // caller
  }
}
class Settings {
  static public int additionalSpeed = 0;
}
class MyTurtle {
  private Turtle t;
  public int base;

  MyTurtle(int x, int y) {
    this.turtle = new Turtle(x, y); // step
    this.base = 1; // step
  }
  void moveForward() {
    for (int i = 0; i < this.base + Settings.additionalSpeed; i++) // step
      this.turtle.前に進む(); // step
  }
}
    `,
  },
  // ----------- 初級プログラミングⅡ 第4回 ここまで -----------

  // ----------- 初級プログラミングⅡ 第5回 ここから -----------
  inheritance1: {
    // 独自クラスを定義するコードでは `main()` 関数を定義すること。
    instrumented: `
function main() {
  const t = call(CurveTurtle)();
  call(t.drawCurve.bind(t))();
}

class MyTurtle {
  constructor() {
    this.t = new Turtle(); // step
  }
  drawLine() {
    this.t.前に進む(); // step
    this.t.前に進む(); // step
  }
}

class CurveTurtle extends MyTurtle {
  drawCurve() {
    call(this.drawLine.bind(this))();
    this.t.右を向く(); // step
    call(this.drawLine.bind(this))();
  }
}
main();
`,
    java: `
public class Main {
  public static void main(String[] args) {
    CurveTurtle t = new CurveTurtle(); // caller
    t.drawCurve(); // caller
  }
}
class MyTurtle {
  Turtle t = new Turtle(); // step

  void drawLine() {
    this.t.前に進む(); // step
    this.t.前に進む(); // step
  }
}
class CurveTurtle extends MyTurtle {
  void drawCurve() {
    this.drawLine(); // caller
    this.t.右を向く(); // step
    this.drawLine(); // caller
  }
}
`,
  },
  inheritance2: {
    instrumented: `
function main() {
  const t = call(CurveTurtle, 'p')(2);
  call(t.drawCurve.bind(t))();
}

class MyTurtle {
  constructor(x, y) {
    this.t = new Turtle(x, y); // step
  }
  drawLine() {
    this.t.前に進む(); // step
    this.t.前に進む(); // step
  }
}

class CurveTurtle extends MyTurtle {
  constructor(p) {
    call((x, y) => super(x, y), 'x', 'y')(p, p);
  }
  drawCurve() {
    call(this.drawLine.bind(this))();
    this.t.右を向く(); // step
    call(this.drawLine.bind(this))();
  }
}
main();
`,
    java: `
public class Main {
  public static void main(String[] args) {
    CurveTurtle t = new CurveTurtle(2); // caller
    t.drawCurve(); // caller
  }
}
class MyTurtle {
  Turtle t;
  MyTurtle(int x, int y) {
    this.t = new Turtle(x, y); // step
  }
  void drawLine() {
    this.t.前に進む(); // step
    this.t.前に進む(); // step
  }
}
class CurveTurtle extends MyTurtle {
  CurveTurtle(int p) {
    super(p, p); // caller
  }
  void drawCurve() {
    this.drawLine(); // caller
    this.t.右を向く(); // step
    this.drawLine(); // caller
  }
}
`,
  },
  inheritance3: {
    instrumented: `
function main() {
  const t = call(CurveTurtle, 'p')(0);
  call(t.drawCurve.bind(t))();
  call(t.drawLine.bind(t))();
}

class MyTurtle {
  constructor(x, y) {
    this.t = new Turtle(x, y); // step
  }
  drawLine() {
    this.t.前に進む(); // step
    this.t.前に進む(); // step
  }
}

class CurveTurtle extends MyTurtle {
  constructor(p) {
    call((x, y) => super(x, y), 'x', 'y')(p + 1, p + 2);
  }
  drawCurve() {
    call(this.drawLine.bind(this))();
    this.t.右を向く(); // step
    call(this.drawLine.bind(this))();
  }
}
main();
`,
    java: `
public class Main {
  public static void main(String[] args) {
    CurveTurtle t = new CurveTurtle(0); // caller
    t.drawCurve(); // caller
    t.drawLine(); // caller
  }
}
class MyTurtle {
  Turtle t;
  MyTurtle(int x, int y) {
    this.t = new Turtle(x, y); // step
  }
  void drawLine() {
    this.t.前に進む(); // step
    this.t.前に進む(); // step
  }
}
class CurveTurtle extends MyTurtle {
  CurveTurtle(int p) {
    super(p + 1, p + 2); // caller
  }
  void drawCurve() {
    this.drawLine(); // caller
    this.t.右を向く(); // step
    this.drawLine(); // caller
  }
}
    `,
  },
  inheritance4: {
    instrumented: `
function main() {
  const t = call(SquareTurtle)();
  call(t.drawSquare.bind(t))();
}

class MyTurtle {
  constructor() {
    this.t = new Turtle(0, 1); // step
  }
  drawLine() {
    this.t.前に進む(); // step
    this.t.前に進む(); // step
  }
}

class CurveTurtle extends MyTurtle {
  drawCurve() {
    call(this.drawLine.bind(this))();
    this.t.右を向く(); // step
    call(this.drawLine.bind(this))();
  }
}

class SquareTurtle extends CurveTurtle {
  drawSquare() {
    call(this.drawCurve.bind(this))();
    this.t.右を向く(); // step
    call(this.drawCurve.bind(this))();
  }
}

main();
`,
    java: `
public class Main {
  public static void main(String[] args) {
    SquareTurtle t = new SquareTurtle(); // caller
    t.drawSquare(); // caller
  }
}
class MyTurtle {
  Turtle t = new Turtle(0, 1); // step
  void drawLine() {
    this.t.前に進む(); // step
    this.t.前に進む(); // step
  }
}
class CurveTurtle extends MyTurtle {
  void drawCurve() {
    this.drawLine(); // caller
    this.t.右を向く(); // step
    this.drawLine(); // caller
  }
}
class SquareTurtle extends CurveTurtle {
  void drawSquare() {
    this.drawCurve(); // caller
    this.t.右を向く(); // step
    this.drawCurve(); // caller
  }
}
    `,
  },
  override1: {
    instrumented: `
function main() {
  const t = call(FastTurtle)(); // caller
  call(t.drawLine.bind(t))(); // caller
}

class MyTurtle {
  constructor() {
    this.t = new Turtle(); // step
  }

  drawLine() {
    for (s.set('i', 0); s.get('i') < this.length(); s.set('i', s.get('i') + 1)) { // step // caller
      this.t.前に進む(); // step
    }
    delete s.vars['i'];
  }

  length() {
    return 2;
  }
}

class FastTurtle extends MyTurtle {
  length() {
    return 3;
  }
}
main();
`,
    java: `
public class Main {
  public static void main(String[] args) {
    FastTurtle t = new FastTurtle(); // caller
    t.drawLine(); // caller
  }
}
class MyTurtle {
  Turtle t = new Turtle(); // step

  void drawLine() {
    for (int i = 0; i < this.length(); i++) { // step
      this.t.前に進む();  // step
    }
  }
  int length() {
    return 2;
  }
}
class FastTurtle extends MyTurtle {
  @Override int length() {
    return 3;
  }
}
`,
  },
  override2: {
    instrumented: `
function main() {
  const t = call(SuperFastTurtle)();
  call(t.drawLine.bind(t))();
}

class MyTurtle {
  constructor() {
    this.t = new Turtle(); // step
  }

  drawLine() {
    for (s.set('i', 0); s.get('i') < this.length(); s.set('i', s.get('i') + 1)) { // step
      this.t.前に進む(); // step
    }
    delete s.vars['i'];
  }

  length() {
    return 2;
  }
}

class FastTurtle extends MyTurtle {
  length() {
    return super.length() + 1;
  }
}

class SuperFastTurtle extends FastTurtle {
  length() {
    return super.length() + 1;
  }
}

main();
`,
    java: `
public class Main {
  public static void main(String[] args) {
    SuperFastTurtle t = new SuperFastTurtle(); // caller
    t.drawLine(); // caller
  }
}
class MyTurtle {
  Turtle t = new Turtle(); // step
  void drawLine() {
    for (int i = 0; i < this.length(); i++) { // step
      this.t.前に進む(); // step
    }
  }
  int length() {
    return 2;
  }
}
class FastTurtle extends MyTurtle {
  @Override int length() {
    // 親クラス (MyTurtle) の length() を呼び出す。
    return super.length() + 1;
  }
}
class SuperFastTurtle extends FastTurtle {
  @Override int length() {
    // 親クラス (FastTurtle) の length() を呼び出す。
    return super.length() + 1;
  }
}
`,
  },
  override3: {
    instrumented: `
function main() {
  const t = call(FastCurveTurtle)();
  call(t.draw.bind(t))();
}

class MyTurtle {
  constructor() {
    this.t = new Turtle(); // step
  }

  draw() {
    for (s.set('i', 0); s.get('i') < this.length(); s.set('i', s.get('i') + 1)) { // step
      this.t.前に進む(); // step
    }
    delete s.vars['i'];
  }

  length() {
    return 2;
  }
}

class FastCurveTurtle extends MyTurtle {
  draw() {
    call(super.draw.bind(this))();
    this.t.右を向く(); // step
    call(super.draw.bind(this))();
  }

  length() {
    return super.length() + 1;
  }
}

main();
`,
    java: `
public class Main {
  public static void main(String[] args) {
    FastCurveTurtle t = new FastCurveTurtle(); // caller
    t.draw(); // caller
  }
}
class MyTurtle {
  Turtle t = new Turtle(); // step
  void draw() {
    for (int i = 0; i < this.length(); i++) { // step
      this.t.前に進む(); // step
    }
  }
  int length() {
    return 2;
  }
}
class FastCurveTurtle extends MyTurtle {
  @Override void draw() {
    // 親クラス (MyTurtle) の draw() を呼び出す。
    super.draw(); // caller
    this.t.右を向く(); // step
    // 親クラス (MyTurtle) の draw() を呼び出す。
    super.draw(); // caller
  }
  @Override int length() {
    // 親クラス (MyTurtle) の length() を呼び出す。
    return super.length() + 1;
  }
}
`,
  },
  polymorphism1: {
    instrumented: `
function main() {
  const ts = [
    call(MyTurtle, 'x', 'y')(0, 0),
    call(FastTurtle, 'p')(1)
  ];
  for (s.set('i', 0); s.get('i') < ts.length; s.set('i', s.get('i') + 1)) { // step
    call(ts[s.get('i')].drawLine.bind(ts[s.get('i')]))(); // caller
  }
  delete s.vars['i'];
}

class MyTurtle {
  constructor(x, y) {
    this.t = new Turtle(x, y); // step
  }

  drawLine() {
    for (s.set('i', 0); s.get('i') < this.length(); s.set('i', s.get('i') + 1)) { // step
      this.t.前に進む(); // step
    }
    delete s.vars['i'];
  }

  length() {
    return 2;
  }
}

class FastTurtle extends MyTurtle {
  constructor(p) {
    call((x, y) => super(x, y), 'x', 'y')(p, p);
  }

  length() {
    return 3;
  }
}

main();
`,
    java: `
public class Main {
  public static void main(String[] args) {
    MyTurtle[] ts = {
      new MyTurtle(0, 0), // caller
      new FastTurtle(1) // caller
    };
    for (int i = 0; i < ts.length; i++) { // step
      ts[i].drawLine(); // caller
    }
  }
}
class MyTurtle {
  Turtle t;
  MyTurtle(int x, int y) {
    this.t = new Turtle(x, y); // step
  }
  void drawLine() {
    for (int i = 0; i < this.length(); i++) { // step
      this.t.前に進む();  // step
    }
  }
  int length() { return 2; }
}
class FastTurtle extends MyTurtle {
  FastTurtle(int p) {
    super(p, p); // caller
  }
  @Override int length() { return 3; }
}
`,
  },
  polymorphism2: {
    instrumented: `
function main() {
  const ts = [
    call(FastTurtle, 'p')(3),
    call(CurveTurtle, 'p')(0)
  ];
  for (s.set('i', 0); s.get('i') < ts.length; s.set('i', s.get('i') + 1)) { // step
    call(ts[s.get('i')].draw.bind(ts[s.get('i')]))();
  }
  delete s.vars['i'];
}

class MyTurtle {
  constructor(x, y) {
    this.t = new Turtle(x, y); // step
  }

  draw() {
    for (s.set('i', 0); s.get('i') < this.length(); s.set('i', s.get('i') + 1)) { // step
      this.t.前に進む(); // step
    }
    delete s.vars['i'];
  }

  length() {
    return 2;
  }
}

class FastTurtle extends MyTurtle {
  constructor(p) {
    call((x, y) => super(x, y), 'x', 'y')(p, p);
  }

  length() {
    return 3;
  }
}

class CurveTurtle extends MyTurtle {
  constructor(p) {
    call((x, y) => super(x, y), 'x', 'y')(p, p + 1);
  }

  draw() {
    call(super.draw.bind(this))();
    this.t.右を向く(); // step
    call(super.draw.bind(this))();
  }
}

main();
`,
    java: `
public class Main {
  public static void main(String[] args) {
    MyTurtle[] ts = {
      new FastTurtle(3), // caller
      new CurveTurtle(0) // caller
    };
    for (int i = 0; i < ts.length; i++) { // step
      ts[i].draw(); // caller
    }
  }
}
class MyTurtle {
  Turtle t;
  MyTurtle(int x, int y) {
    this.t = new Turtle(x, y); // step
  }
  void draw() {
    for (int i = 0; i < this.length(); i++) { // step
      this.t.前に進む(); // step
    }
  }
  int length() { return 2; }
}
class FastTurtle extends MyTurtle {
  FastTurtle(int p) {
    super(p, p); // caller
  }
  @Override int length() { return 3; }
}
class CurveTurtle extends MyTurtle {
  CurveTurtle(int p) {
    super(p, p + 1); // caller
  }
  @Override void draw() {
    // 親クラス (MyTurtle) の draw() を呼び出す。
    super.draw(); // caller
    this.t.右を向く(); // step
    // 親クラス (MyTurtle) の draw() を呼び出す。
    super.draw(); // caller
  }
}
`,
  },
  polymorphism3: {
    instrumented: `
function main() {
  const ts = [
    call(MyTurtle, 'x', 'y')(0, 0),
    call(FastTurtle, 'p')(3),
    call(CurveTurtle, 'p')(2)
  ];
  for (s.set('i', 0); s.get('i') < ts.length; s.set('i', s.get('i') + 1)) { // step
    call(ts[s.get('i')].draw.bind(ts[s.get('i')]))();
    ts[s.get('i')].t.右を向く(); // step
    call(ts[s.get('i')].draw.bind(ts[s.get('i')]))();
  }
  delete s.vars['i'];
}

class MyTurtle {
  constructor(x, y) {
    this.t = new Turtle(x, y); // step
  }

  draw() {
    for (s.set('i', 0); s.get('i') < this.length(); s.set('i', s.get('i') + 1)) { // step
      this.t.前に進む(); // step
    }
    delete s.vars['i'];
  }

  length() {
    return 2;
  }
}

class FastTurtle extends MyTurtle {
  constructor(p) {
    call((x, y) => super(x, y), 'x', 'y')(p, p);
  }

  length() {
    return 3;
  }
}

class CurveTurtle extends MyTurtle {
  constructor(p) {
    call((x, y) => super(x, y), 'x', 'y')(p, p + 1);
  }

  draw() {
    call(super.draw.bind(this))();
    this.t.右を向く(); // step
    call(super.draw.bind(this))();
  }
}

main();
`,
    java: `
public class Main {
  public static void main(String[] args) {
    MyTurtle[] ts = {
      new MyTurtle(0, 0), // caller
      new FastTurtle(3), // caller
      new CurveTurtle(2) // caller
    };
    for (int i = 0; i < ts.length; i++) { // step
      ts[i].draw(); // caller
      ts[i].t.右を向く(); // step
      ts[i].draw(); // caller
    }
  }
}
class MyTurtle {
  Turtle t;
  MyTurtle(int x, int y) {
    this.t = new Turtle(x, y); // step
  }
  void draw() {
    for (int i = 0; i < this.length(); i++) { // step
      this.t.前に進む(); // step
    }
  }
  int length() { return 2; }
}
class FastTurtle extends MyTurtle {
  FastTurtle(int p) {
    super(p, p); // caller
  }
  @Override int length() { return 3; }
}
class CurveTurtle extends MyTurtle {
  CurveTurtle(int p) {
    super(p, p + 1); // caller
  }
  @Override void draw() {
    // 親クラス (MyTurtle) の draw() を呼び出す。
    super.draw(); // caller
    this.t.右を向く(); // step
    // 親クラス (MyTurtle) の draw() を呼び出す。
    super.draw(); // caller
  }
}
    `,
  },

  // ----------- 初級プログラミングⅡ 第5回 ここまで -----------

  // ----------- 初級プログラミングⅡ 第6回 ここから -----------
  package1: {
    instrumented: `
function main() {
  const fast = call(FastTurtle)();
  call(fast.drawLine.bind(fast))();
}

class MyTurtle {
  constructor() {
    this.t = new Turtle(); // step
  }
  drawLine() {
    for (s.set('i', 0); s.get('i') < this.length(); s.set('i', s.get('i') + 1)) { // step
      this.t.前に進む(); // step
    }
    delete s.vars['i'];
  }
  length() { return 2; }
}

class FastTurtle extends MyTurtle {
  length() { return 3; }
}

main();
`,
    java: `
// トレース道場では、複数ファイルの内容をまとめて表示する。

// -------------- Main.java ここから --------------
import turtle.FastTurtle;
public class Main {
  public static void main(String[] a) {
    FastTurtle fast = new FastTurtle(); // caller
    fast.drawLine(); // caller
  }
}
// -------------- Main.java ここまで --------------

// -------- turtle/MyTurtle.java ここから --------
package turtle;
public class MyTurtle {
  private Turtle t = new Turtle(); // step
  public void drawLine() {
    for (int i = 0; i < this.length(); i++) // step
      this.t.前に進む(); // step
  }
  protected int length() { return 2; }
}
// -------- turtle/MyTurtle.java ここまで --------

// ------- turtle/FastTurtle.java ここから -------
package turtle;
public class FastTurtle extends MyTurtle {
  @Override protected int length() { return 3; }
}
// ------- turtle/FastTurtle.java ここまで -------
`,
  },
  package2: {
    instrumented: `
function main() {
  const t = call(BoldLineTurtle)();
  call(t.draw.bind(t))();
}

class LineTurtle {
  constructor() {
    this.t = new Turtle(); // step
  }
  draw() {
    for (s.set('i', 0); s.get('i') < 3; s.set('i', s.get('i') + 1)) { // step
      call(this.forward.bind(this))();
    }
    delete s.vars['i'];
  }
  forward() {
    this.t.前に進む(); // step
  }
}

class BoldLineTurtle extends LineTurtle {
  forward() {
    this.t.右を向く(); // step
    this.t.前に進む(); // step
    this.t.左を向く(); // step
    this.t.前に進む(); // step
    this.t.左を向く(); // step
    this.t.前に進む(); // step
    this.t.右を向く(); // step
  }
}

main();
`,
    java: `
// トレース道場では、複数ファイルの内容をまとめて表示する。

// -------------- Main.java ここから --------------
import turtle.BoldLineTurtle;
public class Main {
  public static void main(String[] a) {
    BoldLineTurtle t = new BoldLineTurtle(); // caller
    t.draw(); // caller
  }
}
// -------------- Main.java ここまで --------------

// -------- turtle/LineTurtle.java ここから --------
package turtle;
public class LineTurtle {
  private Turtle t = new Turtle(); // step
  public void draw() {
    for (int i = 0; i < 3; i++) // step
      this.forward(); // caller
  }
  protected void forward() {
  	this.t.前に進む(); // step
  }
}
// -------- turtle/LineTurtle.java ここまで --------

// ------- turtle/BoldLineTurtle.java ここから -------
package turtle;
public class BoldLineTurtle extends LineTurtle {
  @Override protected void forward() {
		this.t.右を向く(); // step
		this.t.前に進む(); // step
		this.t.左を向く(); // step
		this.t.前に進む(); // step
		this.t.左を向く(); // step
		this.t.前に進む(); // step
		this.t.右を向く(); // step
  }
}
// ------- turtle/BoldLineTurtle.java ここまで -------
`,
  },
  package3: {
    instrumented: `
function main() {
  const ts = [
    call(LineTurtle, 'x', 'y')(0, 0),
    call(LongLineTurtle, 'x', 'y')(3, 0)
  ];
  for (const t of ts) {
    call(t.draw.bind(t))();
  }
}

class LineTurtle {
  constructor(x, y) {
    this.t = new Turtle(x, y); // step
  }
  draw() {
    for (s.set('i', 0); s.get('i') < 3; s.set('i', s.get('i') + 1)) { // step
      call(this.forward.bind(this))();
    }
    delete s.vars['i'];
  }
  forward() {
    this.t.前に進む(); // step
  }
}

class LongLineTurtle extends LineTurtle {
  forward() {
    this.t.前に進む(); // step
    this.t.前に進む(); // step
  }
}

main();
`,
    java: `
// トレース道場では、複数ファイルの内容をまとめて表示する。

// -------------- Main.java ここから --------------
import turtle.*;
public class Main {
  public static void main(String[] a) {
    LineTurtle[] ts = {
      new LineTurtle(0, 0), // caller
      new LongLineTurtle(3, 0) // caller
    };
    for (LineTurtle t : ts)
      t.draw(); // caller
  }
}
// -------------- Main.java ここまで --------------

// -------- turtle/LineTurtle.java ここから --------
package turtle;
public class LineTurtle {
  protected Turtle t;
  public LineTurtle(int x, int y) {
    this.t = new Turtle(x, y); // step
  }
  public void draw() {
    for (int i = 0; i < 3; i++) // step
      this.forward(); // caller
  }
  protected void forward() {
  	this.t.前に進む(); // step
  }
}
// -------- turtle/LineTurtle.java ここまで --------

// ------- turtle/LongLineTurtle.java ここから -------
package turtle;
public class LongLineTurtle extends LineTurtle {
  @Override protected void forward() {
		this.t.前に進む(); // step
		this.t.前に進む(); // step
  }
}
// ------- turtle/LongLineTurtle.java ここまで -------
`,
  },
  overload1: {
    instrumented: `
function main() {
  const t = call(CurveTurtle)();
  call(t.drawCurve.bind(t))();
}

class MyTurtle {
  constructor() {
    this.t = new Turtle(); // step
  }
  drawLine(steps) {
    for (s.set('i', 0); s.get('i') < steps; s.set('i', s.get('i') + 1)) { // step
      this.t.前に進む(); // step
    }
    delete s.vars['i'];
  }
  drawLine2() {
    call(this.drawLine.bind(this), 'steps')(2);
  }
}

class CurveTurtle extends MyTurtle {
  drawCurve() {
    call(this.drawLine.bind(this), 'steps')(3);
    this.t.右を向く(); // step
    call(this.drawLine2.bind(this))();
  }
}

main();
    `,
    java: `
public class Main {
  public static void main(String[] args) {
    CurveTurtle t = new CurveTurtle(); // caller
    t.drawCurve(); // caller
  }
}
class MyTurtle {
  Turtle t = new Turtle(); // step
  void drawLine(int steps) {
    for (int i = 0; i < steps; i++) // step
      this.t.前に進む(); // step
  }
  void drawLine() {
    this.drawLine(2); // caller
  }
}
class CurveTurtle extends MyTurtle {
  void drawCurve() {
    this.drawLine(3); // caller
    this.t.右を向く(); // step
    this.drawLine(); // caller
  }
}
    `,
  },
  overload2: {
    instrumented: `
function main() {
  const t = call(MyTurtle, 'x', 'y')(0, 0);
  call(t.operate.bind(t), 'n')(0);
  call(t.operate2.bind(t), 's')("right");
  call(t.operate2.bind(t), 's')("up");
  call(t.operate.bind(t), 'n')(1);
  call(t.operate.bind(t), 'n')(0);
}

class MyTurtle {
  constructor(x, y) {
    this.t = new Turtle(x, y); // step
  }

  operate(n) {
    if (n === 0) {
      this.t.前に進む(); // step
    } else if (n === 1) {
      this.t.右を向く(); // step
      this.t.前に進む(); // step
      this.t.左を向く(); // step
    }
  }

  operate2(s) {
    if (s === "up") {
      call(this.operate.bind(this), 'n')(0);
    } else if (s === "right") {
      call(this.operate.bind(this), 'n')(1);
    }
  }
}

main();
`,
    java: `
public class Main {
  public static void main(String[] args) {
    MyTurtle t = new MyTurtle(); // caller
    t.operate(0); // caller
    t.operate("right"); // caller
    t.operate("up"); // caller
    t.operate(1); // caller
    t.operate(0); // caller
  }
}
class MyTurtle {
  private Turtle t = new Turtle(0, 0); // step
  public void operate(int n) {
    if (n == 0) {
      this.t.前に進む(); // step
    } else if (n == 1) {
      this.t.右を向く(); // step
      this.t.前に進む(); // step
      this.t.左を向く(); // step
    }
  }
  public void operate(String s) {
    if (s.equals("up")) {
      operate(0); // caller
    } else if (s.equals("right")) {
      operate(1); // caller
    }
  }
}
    `,
  },
  overload3: {
    instrumented: `
function main() {
  const t = call(MyTurtle)();
  call(t.drawLine.bind(t), 'steps')(max(2, 3));
  t.t.右を向く(); // step
  call(t.drawLine.bind(t), 'steps')(max3(2, 3, 4));
  t.t.右を向く(); // step
  call(t.drawLine.bind(t), 'steps')(max(2, 1));
  t.t.右を向く(); // step
  call(t.drawLine.bind(t), 'steps')(max3(3, 2, 1));
  t.t.右を向く(); // step
}

function max(a, b) {
  if (a > b) return a;
  else return b;
}

function max3(a, b, c) {
  if (a >= b && a >= c) return a;
  else if (b >= c) return b;
  else return c;
}

class MyTurtle {
  constructor() {
    this.t = new Turtle(); // step
  }

  drawLine(steps) {
    for (s.set('i', 0); s.get('i') < steps; s.set('i', s.get('i') + 1)) { // step
      this.t.前に進む(); // step
    }
    delete s.vars['i'];
  }
}
main();
`,
    java: `
public class Main {
  public static void main(String[] args) {
    MaxTurtle t = new MaxTurtle(); // caller
    drawLine(max(2, 3)); // caller
    this.t.右を向く(); // step
    drawLine(max(2, 3, 4)); // caller
    this.t.右を向く(); // step
    drawLine(max(2, 1)); // caller
    this.t.右を向く(); // step
    drawLine(max(3, 2, 1)); // caller
    this.t.右を向く(); // step
  }
  public static int max(int a, int b) {
    if (a > b) return a;
    else return b;
  }
  public static int max(int a, int b, int c) {
    if (a >= b && a >= c) return a;
    else if (b >= c) return b;
    else return c;
  }
}
class MyTurtle {
  public Turtle t = new Turtle(); // step
  public void drawLine(int steps) {
    for (int i = 0; i < steps; i++) // step
      this.t.前に進む(); // step
  }
}
    `,
  },
  overload4: {
    instrumented: `
function main() {
  const t = call(MyTurtle)();
  call(t.move.bind(t), 'dy')(2);
  call(t.move2.bind(t), 'dx', 'dy')(1, 3);
  call(t.move.bind(t), 'dy')(-3);
  call(t.move2.bind(t), 'dx', 'dy')(-1, 0);
  call(t.move2.bind(t), 'dx', 'dy')(4, 2);
  call(t.move2.bind(t), 'dx', 'dy')(0, -4);
}

class MyTurtle {
  constructor(x, y) {
    this.t = new Turtle(x, y); // step
  }

  move(dy) {
    while (s.get('dy') > 0) {
      s.set('dy', s.get('dy') - 1); // step
      this.t.前に進む(); // step
    }
    while (s.get('dy') < 0) {
      s.set('dy', s.get('dy') + 1); // step
      this.t.後に戻る(); // step
    }
  }

  move2(dx, dy) {
    call(this.move.bind(this), 'dy')(dy);
    if (s.get('dx') != 0) {
      this.t.右を向く(); // step
      while (s.get('dx') > 0) {
        s.set('dx', s.get('dx') - 1); // step
        this.t.前に進む(); // step
      }
      while (s.get('dx') < 0) {
        s.set('dx', s.get('dx') + 1); // step
        this.t.後に戻る(); // step
      }
      this.t.左を向く(); // step
    }
  }
}

main();
`,
    java: `
public class Main {
  public static void main(String[] a) {
    MyTurtle t = new MyTurtle(); // caller
    t.move(2); // caller
    t.move(1, 3); // caller
    t.move(-3); // caller
    t.move(-1, 0); // caller
    t.move(4, 2); // caller
    t.move(0, -4); // caller
  }
}
public class MyTurtle {
  private Turtle t = new Turtle(0, 0); // step
  public void move(int dy) {
    while (dy > 0) {
      dy--; // step
      this.t.前に進む(); // step
    }
    while (dy < 0) {
      dy++; // step
      this.t.後に戻る(); // step
    }
  }
  public void move(int dx, int dy) {
    move(dy); // caller
    if (dx != 0) {
      this.t.右を向く(); // step
      while (dx > 0) {
        dx--; // step
        this.t.前に進む(); // step
      }
      while (dx < 0) {
        dx++; // step
        this.t.後に戻る(); // step
      }
      this.t.左を向く(); // step
    }
  }
}
`,
  },

  overloadAndOverride1: {
    instrumented: `
function main() {
  const m2 = call(MyTurtle2)();
  call(m2.drawLine2.bind(m2))();
  const m3 = call(MyTurtle3)();
  call(m3.drawLine2.bind(m3))();
  const ms = [m2, m3];
  for (const m of ms) {
    m.t.右を向く(); // step
    call(m.drawLine2.bind(m))();
  }
}

class MyTurtle {
  constructor() {
    this.t = new Turtle(); // step
  }
  drawLine(steps) {
    for (s.set('i', 0); s.get('i') < steps; s.set('i', s.get('i') + 1)) { // step
      this.t.前に進む(); // step
    }
    delete s.vars['i'];
  }
  drawLine2() {
    call(this.drawLine.bind(this), 'steps')(2);
  }
}

class MyTurtle2 extends MyTurtle {
  drawLine2() {
    call(this.drawLine.bind(this), 'steps')(4);
  }
}

class MyTurtle3 extends MyTurtle {
  drawLine2() {
    call(this.drawLine.bind(this), 'steps')(3);
  }
}

main();
    `,
    java: `
public class Main {
  public static void main(String[] args) {
    MyTurtle m2 = new MyTurtle2(); // caller
    m2.drawLine(); // caller
    MyTurtle m3 = new MyTurtle3(); // caller
    m3.drawLine(); // caller
    MyTurtle[] ms = { m2, m3 };
    for (MyTurtle m : ms) {
      m.t.右を向く(); // step
      m.drawLine(); // caller
    }
  }
}
class MyTurtle {
  Turtle t = new Turtle(); // step
  void drawLine(int steps) {
    for (int i = 0; i < steps; i++) // step
      this.t.前に進む(); // step
  }
  void drawLine() {
    this.drawLine(2); // caller
  }
}
class MyTurtle2 extends MyTurtle {
  @Override void drawLine() {
    this.drawLine(4); // caller
  }
}
class MyTurtle3 extends MyTurtle {
  @Override void drawLine() {
    this.drawLine(3); // caller
  }
}
    `,
  },
  // ----------- 初級プログラミングⅡ 第6回 ここまで -----------

  // ----------- 初級プログラミングⅡ 第7回 ここから -----------
  // ----------- 初級プログラミングⅡ 第7回 ここまで -----------

  // ----------- 初級プログラミングⅡ 第8回 ここから -----------
  // ----------- 初級プログラミングⅡ 第8回 ここまで -----------
  test1: {
    instrumented: `
const t = new Turtle(); // step
t.forward();
t.forward();
t.forward();
`,
    // stepがただの連番である場合、番号を省略できる。
    java: `
public class Main {
  public static void main(String[] args) {
    Turtle c = new Turtle(); // step
    c.forward(); // step
    c.forward(); // step
    c.forward(); // step
  }
}
`,
  },
  test2: {
    instrumented: `
const t = new Turtle(); // step
for (s.set('i', 0); s.get('i') < 2; s.set('i', s.get('i') + 1)) {
  t.forward();
  t.forward();
  t.turnRight();
}
delete s.vars['i'];
`,
    java: `
public class Main {
  public static void main(String[] args) {
    Turtle c = new Turtle(); // step
    for (let i = 0; i < 2; i++) { // step
      c.forward(); // step
      c.forward(); // step
      c.turnRight(); // step
    }
  }
}
`,
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
    int a = 1; // step: 1
    if (a > 0) {
      int b = 2; // step: 2
      a = f(a, b); // step: 3 // caller
    }
    int c = a * 2; // step: 4
  }

  public static int f(int x, int y) {
    int a = x * y; // step: 5
    return a;
  }
}
`,
  },
  test4: {
    instrumented: `
const t1 = new Turtle(); // step
t1.forward();
t1.turnRight();
s.set('i', 0);
t1.forward();

const t2 = new Turtle(2, 3, 'G'); // step
t2.forward();
s.set('foo', 'あいうえお');
s.set('bar', <1-100>);
s.set('i', s.get('bar') + 1);
t2.forward();
t2.forward();
`,
    java: `
public class Main {
  public static void main(String[] args) {
    Turtle c1 = new Turtle(); // step
    c1.forward(); // step
    c1.turnRight(); // step
    int i = 0; // step
    c1.forward(); // step

    Turtle c2 = new Turtle(2, 3, "green"); // step
    c2.forward(); // step
    String foo = "あいうえお"; // step
    int bar = <1-100>; // step
    i = bar + 1; // step
    c2.forward(); // step
    c2.forward(); // step
  }
}
`,
  },
  test5: {
    instrumented: `
const t = new Turtle(); // step
t.前に進む(); // step
t.前に進む(); // step
t.右を向く(); // step
t.前に進む(); // step
t.前に進む(); // step
t.前に進む(); // step
t.前に進む(); // step
`,
    java: `
public class Straight {
  public static void main(String[] args) {
    var c = new Turtle(); // step
    c.前に進む(); // step
    c.前に進む(); // step
    c.右を向く(); // step
    c.前に進む(); // step
    c.前に進む(); // step
    c.前に進む(); // step
    c.前に進む(); // step
  }
}
`,
  },
  test9: {
    instrumented: `
myGlobal.Settings = { speed: 0 };

function main() {
  const t1 = call(MyTurtle)();
  myGlobal.Settings.speed = 2; // step
  call(t1.moveForward.bind(t1))();

  const t2 = call(MyTurtle2, 'x', 'y')(2, 2);
  call(increaseSpeed)();
  call(t1.moveForward.bind(t1))();
  call(t2.moveForward.bind(t2))();
}

function increaseSpeed() {
  myGlobal.Settings.speed++; // step
}

class MyTurtle {
  constructor() {
    this.t = new Turtle(); // step
  }

  moveForward() {
    for (s.set('i', 0); s.get('i') < myGlobal.Settings.speed; s.set('i', s.get('i') + 1)) { // step
      this.t.前に進む(); // step
    }
    delete s.vars['i'];
  }
}

class MyTurtle2 {
  constructor(x, y) {
    this.t = new Turtle(x, y); // step
  }

  moveForward() {
    for (s.set('i', 0); s.get('i') < myGlobal.Settings.speed; s.set('i', s.get('i') + 1)) { // step
      this.t.前に進む(); // step
    }
    delete s.vars['i'];
  }
}

main();
`,
    java: `
public class Main {
  public static void main(String[] args) {
    MyTurtle t1 = new MyTurtle(); // caller
    Settings.speed = 2; // step
    t1.moveForward(); // caller

    MyTurtle t2 = new MyTurtle2(2, 2); // caller
    Settings.increaseSpeed(); // caller
    t1.moveForward(); // caller
    t2.moveForward(); // caller
  }
}

class Settings {
  static public int speed;

  public increaseSpeed() {
    speed++; // step
  }
}

class MyTurtle {
  private Turtle t = new Turtle(); // step

  void moveForward(Turtle t) {
    for (int i = 0; i < Settings.speed; i++) { // step
      t.前に進む(); // step
    }
  }
}

class MyTurtle2 {
  private Turtle t;

  MyTurtle2(int x, int y) {
    t = new Turtle(x, y); // step
  }
  void moveForward(Turtle t) {
    for (int i = 0; i < Settings.speed; i++) { // step
      t.前に進む(); // step
    }
  }
}
`,
  },
};

for (const problem of Object.values(problemIdToLanguageIdToProgram)) {
  for (const languageId of languageIds) {
    problem[languageId] = problem[languageId].trim();
  }
}
