import { type ChallengeId, challengeMetadata } from './challenge/metadata';
import { fillInBlankProblemDefinitions } from './fillInBlank/definitions';
import { type JavaChallengeId, javaChallengeMetadata } from './javaChallenges/metadata';

export const courseIdToName = {
  tuBeginner1: '初級プログラミングⅠ',
  tuBeginner2: '初級プログラミングⅡ',
  test: '動作確認用',
} as const;
export type CourseId = keyof typeof courseIdToName;
export const courseIds = Object.keys(courseIdToName) as CourseId[];

const legacyProblemIdToName = {
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
  overloadAndOverride2: 'オーバーロードとオーバーライド(2)',
  overloadAndOverride3: 'オーバーロードとオーバーライド(3)',
  // 初級プログラミングⅡ 第7回
  exception1: '例外(1)',
  exception2: '例外(2)',
  exception3: '例外(3)',
  exception4: '例外(4)',
  exception5: '例外(5)',
  originalException1: '独自に定義した例外(1)',
  originalException2: '独自に定義した例外(2)',
  originalException3: '独自に定義した例外(3)',
  originalException4: '独自に定義した例外(4)',
  originalException5: '独自に定義した例外(5)',
  // 初級プログラミングⅡ 第8回
  twoDimensionalArray1: '二次元配列(1)',
  twoDimensionalArray2: '二次元配列(2)',
  twoDimensionalArray3: '二次元配列(3)',
  twoDimensionalArray4: '二次元配列(4)',
  twoDimensionalArray5: '二次元配列(5)',
  twoDimensionalArray6: '二次元配列(6)',
  threeDimensionalArray1: '三次元配列(1)',
  threeDimensionalArray2: '三次元配列(2)',
  threeDimensionalArray3: '三次元配列(3)',
  threeDimensionalArray4: '三次元配列(4)',
  // 動作確認用
  oop1: 'オブジェクト指向プログラミング(1)',
  oop2: 'オブジェクト指向プログラミング(2)',
  test1: 'ステップ実行のテスト用問題(1)',
  test2: 'ステップ実行のテスト用問題(2)',
  test3: 'ステップ実行のテスト用問題(3)',
  test4: 'ステップ実行のテスト用問題(4)',
  test5: 'チェックポイント取得のテスト用問題',
  test9: 'ステップ実行のテスト用問題(9)',
  fillInBlank1: '穴埋めのテスト用問題(1)',
  fillInBlank2: '穴埋めのテスト用問題(2)',
  fillInBlank3: '穴埋めのテスト用問題(3)',
  fillInBlank4: '穴埋めのテスト用問題(4)',
  straightBlank: '穴埋めチャレンジ：線を描こう(1)',
  straightSecondBlank: '穴埋めチャレンジ：線を描こう(2)',
  square1Blank: '穴埋めチャレンジ：図形を描こう',
  while1Blank: '穴埋めチャレンジ：while文を使おう',
  doubleLoop1Blank: '穴埋めチャレンジ：二重ループ',
  elseIf1Blank: '穴埋めチャレンジ：else if文を使おう',
  break1Blank: '穴埋めチャレンジ：break文を使おう',
  method1Blank: '穴埋めチャレンジ：メソッドを使おう',
  array1Blank: '穴埋めチャレンジ：配列を使おう',
  multiObject1Blank: '穴埋めチャレンジ：複数のオブジェクトを使おう',
  makeClass1Blank: '穴埋めチャレンジ：クラスを作ろう',
  encapsulationBlank: '穴埋めチャレンジ：カプセル化',
  staticMethod1Blank: '穴埋めチャレンジ：静的メソッド',
  inheritance1Blank: '穴埋めチャレンジ：継承',
  exception1Blank: '穴埋めチャレンジ：例外',
  twoDimensionalArray1Blank: '穴埋めチャレンジ：二次元配列',
  test1Blank: '穴埋めチャレンジのテスト用問題',
  overload1Blank: '穴埋めチャレンジ：オーバーロード',
} as const;
type LegacyProblemId = keyof typeof legacyProblemIdToName;
export type ProblemId = LegacyProblemId | JavaChallengeId | ChallengeId;
export const problemIdToName: Record<ProblemId, string> = {
  ...(Object.fromEntries(Object.entries(javaChallengeMetadata).map(([id, metadata]) => [id, metadata.title])) as Record<
    JavaChallengeId,
    string
  >),
  ...(Object.fromEntries(Object.entries(challengeMetadata).map(([id, metadata]) => [id, metadata.title])) as Record<
    ChallengeId,
    string
  >),
  ...legacyProblemIdToName,
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
    [
      'package1',
      'package2',
      'package3',
      'overload1',
      'overload2',
      'overload3',
      'overload4',
      'overloadAndOverride1',
      'overloadAndOverride2',
      'overloadAndOverride3',
    ],
    // 第7回
    [
      'exception1',
      'exception2',
      'exception3',
      'exception4',
      'exception5',
      'originalException1',
      'originalException2',
      'originalException3',
      'originalException4',
      'originalException5',
    ],
    // 第8回
    [
      'twoDimensionalArray1',
      'twoDimensionalArray2',
      'twoDimensionalArray3',
      'twoDimensionalArray4',
      'twoDimensionalArray5',
      'twoDimensionalArray6',
      'threeDimensionalArray1',
      'threeDimensionalArray2',
      'threeDimensionalArray3',
      'threeDimensionalArray4',
    ],
  ],
  test: [
    [
      'test1',
      'test2',
      'test3',
      'test4',
      'test5',
      'test9',
      'oop1',
      'oop2',
      'fillInBlank1',
      'fillInBlank2',
      'fillInBlank3',
      'fillInBlank4',
      'testTurnBug',
      'testForConditionBug',
    ],
  ],
};

export const courseIdToLectureIndexToExerciseProblemIds: Record<CourseId, ProblemId[][]> = {
  tuBeginner1: Array.from({ length: 8 }, () => []),
  tuBeginner2: Array.from({ length: 8 }, () => []),
  test: [['test1Blank']],
};

for (const [id, metadata] of Object.entries(javaChallengeMetadata)) {
  if (metadata.courseId === 'test')
    courseIdToLectureIndexToExerciseProblemIds.test[metadata.lectureIndex].push(id as JavaChallengeId);
}
for (const [id, metadata] of Object.entries(challengeMetadata)) {
  if (metadata.problemFormat !== 'regular')
    courseIdToLectureIndexToExerciseProblemIds[metadata.courseId][metadata.lectureIndex].push(id as ChallengeId);
}

export const courseIdToLectureIds = JSON.parse(process.env.NEXT_PUBLIC_COURSE_ID_TO_LECTURE_IDS_JSON ?? '{}') as Record<
  CourseId,
  string[]
>;

/** The Java program of a problem, from which its trace is generated. */
export function getProblemProgram(problemId: string): string | undefined {
  return (problemIdToProgram as Partial<Record<string, string>>)[problemId];
}

export const problemIdToProgram: Record<LegacyProblemId, string> = {
  straight: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(); // step
        亀.前に進む(); // step
        亀.前に進む(); // step
    }
}
    `,
  straight2: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(); // step
        亀.前に進む(); // step
        亀.前に進む(); // step
        亀.前に進む(); // step
    }
}
    `,
  stepBack: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(); // step
        亀.前に進む(); // step
        亀.後に戻る(); // step
    }
}
    `,
  stepBack2: `
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
  turnRight: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(); // step
        亀.前に進む(); // step
        亀.右を向く(); // step
        亀.前に進む(); // step
    }
}
    `,
  turnRight2: `
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
  turnLeftAndRight: `
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
  turnLeftAndRight2: `
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
  turnLeftAndRight3: `
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
  turnLeftAndRight4: `
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
  square1: `
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
  square2: `
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
  square3: `
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
  square4: `
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

  variable: `
public class Main {
    public static void main(String[] args) {
        int x = <1-5>; // step
        Turtle 亀 = new Turtle(x, <1-5>); // step
        亀.前に進む(); // step
    }
}
    `,
  variable2: `
public class Main {
    public static void main(String[] args) {
        int a = <2-6>; // step
        a = a - 1; // step
        Turtle 亀 = new Turtle(<1-5>, a); // step
        亀.前に進む(); // step
    }
}
    `,
  variable3: `
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
  variable4: `
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
  variable5: `
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
  variable6: `
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
  variable7: `
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
  variable8: `
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
  variable9: `
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
  variable10: `
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
  while1: `
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
  while2: `
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
  while3: `
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
  while4: `
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
  while5: `
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
  for1: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(); // step
        for (int i = 0; i < <3-5>; i++) { // step
            亀.前に進む(); // step
        }
    }
}
    `,
  for2: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(<1-2>, <1-2>); // step
        for (int i = <1-2>; i < <4-6>; i++) { // step
            亀.前に進む(); // step
        }
    }
}
    `,
  for3: `
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
  for4: `
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
  for5: `
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
  for6: `
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
  for7: `
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
  doubleLoop1: `
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
  doubleLoop2: `
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
  doubleLoop3: `
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
  doubleLoop4: `
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
  doubleLoop5: `
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
  if1: `
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
  if2: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(<1-2>, <1-2>); // step
        t.右を向く(); // step
        for (int i = 0; i < <6-8>; i++) { // step
            t.前に進む(); // step
            if (i % 3 == 1) {
                t.左を向く(); // step
            }
        }
    }
}
    `,
  if3: `
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
  if4: `
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
  if5: `
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
  elseIf1: `
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
  elseIf2: `
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
  elseIf3: `
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
  elseIf4: `
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
  elseIf5: `
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
  switch1: `
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
  switch2: `
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
  switch3: `
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
  switch4: `
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
  switch5: `
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
  break1: `
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
  break2: `
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
  break3: `
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
  break4: `
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
  break5: `
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
  continue1: `
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
  continue2: `
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
  continue3: `
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
  continue4: `
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
  continue5: `
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
  method1: `
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
  method2: `
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
  method3: `
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
  method4: `
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
  method5: `
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
  return1: `
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
  return2: `
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
  return3: `
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
        return a + b;
    }
}
    `,
  return4: `
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
  return5: `
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

  array1: `
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
  array2: `
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
  array3: `
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
  array4: `
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
  array5: `
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
  string1: `
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
  string2: `
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
  string3: `
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
  string4: `
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
  string5: `
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
  oop1: `
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
  oop2: `
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
    for (int i = 0; i < this.speed; i++) { // step
      this.c.前に進む(); // step
    }
  }
}
`,
  // ----------- 初級プログラミングⅡ 第1回 ここから -----------
  multiObject1: `
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
  multiObject2: `
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
  multiObject3: `
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
  multiObject4: `
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
  multiObject5: `
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
  multiObject6: `
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
  garbageCollection1: `
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
  garbageCollection2: `
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
  garbageCollection3: `
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
  garbageCollection4: `
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
  garbageCollection5: `
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
  garbageCollection6: `
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
  // ----------- 初級プログラミングⅡ 第1回 ここまで -----------

  // ----------- 初級プログラミングⅡ 第2回 ここから -----------
  makeClass1: `
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
  makeClass2: `
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
  makeClass3: `
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
  makeClass4: `
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
  makeClass5: `
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
  makeClass6: `
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
  constructor1: `
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
  constructor2: `
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
  constructor3: `
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
  constructor4: `
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
  // ----------- 初級プログラミングⅡ 第2回 ここまで -----------

  // ----------- 初級プログラミングⅡ 第3回 ここから -----------
  encapsulation: `
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
  withoutEncapsulation: `
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
  withEncapsulation: `
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
  withoutEncapsulation2: `
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
  withEncapsulation2: `
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
  withEncapsulation3: `
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
  withEncapsulation4: `
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
  withEncapsulation5: `
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
  withEncapsulation6: `
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
  withEncapsulation7: `
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
  // ----------- 初級プログラミングⅡ 第3回 ここまで -----------

  // ----------- 初級プログラミングⅡ 第4回 ここから -----------
  staticMethod1: `
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
  staticMethod2: `
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
  staticMethod3: `
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
  staticMethod4: `
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
  staticField1: `
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
  staticField2: `
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
  staticField3: `
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
  staticField4: `
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
  staticField5: `
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
  staticField6: `
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
  private Turtle turtle;
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
  // ----------- 初級プログラミングⅡ 第4回 ここまで -----------

  // ----------- 初級プログラミングⅡ 第5回 ここから -----------
  inheritance1: `
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
  inheritance2: `
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
  inheritance3: `
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
  inheritance4: `
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
  override1: `
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
  override2: `
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
  override3: `
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
  polymorphism1: `
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
  polymorphism2: `
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
  polymorphism3: `
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

  // ----------- 初級プログラミングⅡ 第5回 ここまで -----------

  // ----------- 初級プログラミングⅡ 第6回 ここから -----------
  package1: `
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
  package2: `
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
  protected Turtle t = new Turtle(); // step
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
  package3: `
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
  public LongLineTurtle(int x, int y) {
    super(x, y); // caller
  }
  @Override protected void forward() {
		this.t.前に進む(); // step
		this.t.前に進む(); // step
  }
}
// ------- turtle/LongLineTurtle.java ここまで -------
`,
  overload1: `
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
  overload2: `
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
  overload3: `
public class Main {
  public static void main(String[] args) {
    MyTurtle t = new MyTurtle(); // caller
    t.drawLine(max(2, 3)); // caller
    t.t.右を向く(); // step
    t.drawLine(max(2, 3, 4)); // caller
    t.t.右を向く(); // step
    t.drawLine(max(2, 1)); // caller
    t.t.右を向く(); // step
    t.drawLine(max(3, 2, 1)); // caller
    t.t.右を向く(); // step
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
  overload4: `
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
  overloadAndOverride1: `
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
  overloadAndOverride2: `
public class Main {
  public static void main(String[] args) {
    MyTurtle m2 = new MyTurtle2(); // caller
    m2.drawLine(2); // caller
    MyTurtle m3 = new MyTurtle3(); // caller
    m3.drawLine(1); // caller
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
    this.drawLine(3); // caller
  }
}
class MyTurtle3 extends MyTurtle {
  @Override void drawLine() {
    this.drawLine(4); // caller
  }
}
    `,
  overloadAndOverride3: `
public class Main {
  public static void main(String[] args) {
    MyTurtle m1 = new MyTurtle(); // caller
    m1.drawLine(4); // caller
    MyTurtle m2 = new MyTurtle2(); // caller
    m2.drawLine(3); // caller
    MyTurtle m3 = new MyTurtle3(); // caller
    m3.drawLine(1); // caller
    MyTurtle[] ms = { m1, m2, m3 };
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
    this.drawLine(3); // caller
  }
}
class MyTurtle3 extends MyTurtle2 {
  @Override void drawLine(int steps) {
    // MyTurtleクラスの "drawLine(int steps)" を呼ぶ。
    super.drawLine(steps * 2); // caller
  }
}
    `,
  // ----------- 初級プログラミングⅡ 第6回 ここまで -----------

  // ----------- 初級プログラミングⅡ 第7回 ここから -----------
  exception1: `
public class Main {
  public static void main(String[] args) {
    MyTurtle m = new MyTurtle(); // caller
    try {
      m.drawLine(); // caller
      m.drawLine(); // caller
    } catch (Exception e) {
      m.t.右を向く(); // step
      m.t.前に進む(); // step
    }
  }
}

class MyTurtle {
  public Turtle t = new Turtle(); // step

  public void drawLine() {
    for (int i = 0; i < 4; i++) { // step
      if (!t.前に進めるか()) {
        throw new RuntimeException("前に進めない！");
      }
      this.t.前に進む(); // step
    }
  }
}
    `,
  exception2: `
public class Main {
  public static void main(String[] args) {
    MyTurtle m = new MyTurtle(); // caller
    try {
      m.drawLine(); // caller
      m.drawLine(); // caller
    } catch (ArithmeticException e) {
      m.t.右を向く(); // step
      m.t.前に進む(); // step
    }
  }
}

class MyTurtle {
  public Turtle t = new Turtle(); // step

  public void drawLine() {
    for (int i = 0; i < 4; i++) { // step
      if (!t.前に進めるか()) {
        throw new RuntimeException("前に進めない！");
      }
      this.t.前に進む(); // step
    }
  }
}
`,
  exception3: `
public class Main {
  public static void main(String[] args) {
    MyTurtle m = new MyTurtle(); // caller
    try {
      m.drawLine(); // caller
      m.drawLine(); // caller
    } catch (Exception e) {
      m.t.右を向く(); // step
      m.t.前に進む(); // step
      m.t.左を向く(); // step
    }
  }
}

class MyTurtle {
  public Turtle t = new Turtle(); // step

  public void drawLine() {
    for (int i = 0; i < 4; i++) { // step
      if (!t.前に進めるか()) {
        throw new RuntimeException("前に進めない！");
      }
      this.t.前に進む(); // step
    }
  }
}
`,
  exception4: `
public class Main {
  public static void main(String[] args) {
    MyTurtle m = new MyTurtle(); // caller
    try {
      m.drawLine(); // caller
      m.drawLine(); // caller
    } catch (Exception e) {
      m.t.前に進む(); // step
      m.t.右を向く(); // step
    }
  }
}

class MyTurtle {
  public Turtle t = new Turtle(); // step

  public void drawLine() {
    try {
      for (int i = 0; i < 4; i++) { // step
        if (!t.前に進めるか()) {
          throw new RuntimeException("前に進めない！");
        }
        this.t.前に進む(); // step
      }
    } catch (RuntimeException e) {
      t.右を向く(); // step
      throw e; // catchした例外をもう一度throwする。
    }
  }
}
`,
  exception5: `
public class Main {
  public static void main(String[] args) {
    MyTurtle m = new MyTurtle(); // caller
    try {
      m.drawLine(); // caller
      m.drawLine(); // caller
    } catch (RuntimeException e) {
      m.t.前に進む(); // step
      throw e; // catchした例外をもう一度throwする。
    }
  }
}

class MyTurtle {
  public Turtle t = new Turtle(); // step

  public void drawLine() {
    try {
      for (int i = 0; i < 4; i++) { // step
        if (!t.前に進めるか()) {
          throw new RuntimeException("前に進めない！");
        }
        this.t.前に進む(); // step
      }
    } catch (RuntimeException e) {
      t.右を向く(); // step
      throw e; // catchした例外をもう一度throwする。
    }
  }
}
`,
  originalException1: `
public class Main {
  public static void main(String[] args) {
    MyTurtle m = new MyTurtle(); // caller
    m.drawLine(); // caller
    m.drawLine(); // caller
  }
}

class OutOfBoardException extends Exception { }

class MyTurtle {
  public Turtle t = new Turtle(); // step

  public void drawLine() {
    try {
      for (int i = 0; i < 4; i++) { // step
        if (!this.t.前に進めるか()) {
          throw new OutOfBoardException();
        }
        this.t.前に進む(); // step
      }
    } catch (Exception e) {
      this.t.右を向く(); // step
      this.t.前に進む(); // step
    }
  }
}
`,
  originalException2: `
public class Main {
  public static void main(String[] args) {
    MyTurtle m = new MyTurtle(); // caller
    try {
      m.drawLine(); // caller
      m.drawLine(); // caller
    } catch (OutOfBoardException e) {
      m.t.右を向く(); // step
      m.t.前に進む(); // step
    }
  }
}

class MyTurtle {
  public Turtle t = new Turtle(); // step

  public void drawLine() throws OutOfBoardException {
    for (int i = 0; i < 4; i++) { // step
      if (!this.t.前に進めるか()) {
        throw new OutOfBoardException();
      }
      this.t.前に進む(); // step
    }
  }
}

class OutOfBoardException extends Exception { }
`,
  originalException3: `
public class Main {
  public static void main(String[] args) {
    MyTurtle m = new MyTurtle(); // caller
    try {
      m.drawSquare(); // caller
    } catch (OutOfBoardException e) {
      m.t.右を向く(); // step
      m.t.前に進む(); // step
    } catch (ColoredException e) {
      m.t.前に進む(); // step
      m.t.左を向く(); // step
    }
  }
}

class OutOfBoardException extends Exception { }
class ColoredException extends Exception { }

class MyTurtle {
  public Turtle t = new Turtle(); // step

  public void drawSquare()
        throws OutOfBoardException, ColoredException {
    for (int i = 0; i < 4; i++) { // step
      if (!this.t.前に進めるか()) {
        throw new OutOfBoardException();
      }
      if (this.t.前のマスが塗られているか()) {
        throw new ColoredException();
      }
      this.t.前に進む(); // step
      this.t.右を向く(); // step
    }
  }
}
`,
  originalException4: `
public class Main {
  public static void main(String[] args) {
    MyTurtle m = new MyTurtle(); // caller
    try {
      m.drawSquare(); // caller
    } catch (Exception e) {
      m.t.左を向く(); // step
      m.t.左を向く(); // step
      m.t.前に進む(); // step
    }
  }
}

class OutOfBoardException extends Exception { }
class ColoredException extends Exception { }

class MyTurtle {
  public Turtle t = new Turtle(5, 4); // step

  public void drawSquare()
        throws OutOfBoardException, ColoredException {
    for (int i = 0; i < 4; i++) { // step
      for (int j = 0; j < 2; j++) { // step
        if (!this.t.前に進めるか()) {
          throw new OutOfBoardException();
        }
        if (this.t.前のマスが塗られているか()) {
          throw new ColoredException();
        }
        this.t.前に進む(); // step
      }
      this.t.右を向く(); // step
    }
  }
}
`,
  originalException5: `
public class Main {
  public static void main(String[] args) {
    MyTurtle m = new MyTurtle(); // caller
    for (int n = 0; n < 3; n++) { // step
      try {
        m.drawSquare(n + 1); // caller
      } catch (OutOfBoardException e) {
        m.t.右を向く(); // step
        m.t.右を向く(); // step
      } catch (ColoredException e) {
        m.t.前に進む(); // step
        m.t.前に進む(); // step
      }
    }
  }
}

class OutOfBoardException extends Exception { }
class ColoredException extends Exception { }

class MyTurtle {
  public Turtle t = new Turtle(5, 5); // step

  public void drawSquare(int size)
        throws OutOfBoardException, ColoredException {
    for (int i = 0; i < 4; i++) { // step
      for (int j = 0; j < size; j++) { // step
        if (!this.t.前に進めるか()) {
          throw new OutOfBoardException();
        }
        if (this.t.前のマスが塗られているか()) {
          throw new ColoredException();
        }
        this.t.前に進む(); // step
      }
      this.t.右を向く(); // step
    }
  }
}
  `,
  // ----------- 初級プログラミングⅡ 第7回 ここまで -----------

  // ----------- 初級プログラミングⅡ 第8回 ここから -----------
  twoDimensionalArray1: `
public class Main {
  public static void main(String[] args) {
    int [][] arr = { { 0, 3 }, { 1, 1 }, { 0, 2 },
                     { 2, 3 }, { 0, 1 }, };
    Turtle t = new Turtle(); // step
    for (int i = 0; i < arr.length; i++) { // step
      int c = arr[i][1]; // step
      switch (arr[i][0]) {
        case 0:
          for (int j = 0; j < c; j++) { // step
            t.前に進む(); // step
          }
          break;
        case 1:
          for (int j = 0; j < c; j++) { // step
            t.右を向く(); // step
          }
          break;
        case 2:
          for (int j = 0; j < c; j++) { // step
            t.左を向く(); // step
          }
          break;
      }
    }
  }
}
  `,
  twoDimensionalArray2: `
public class Main {
  public static void main(String[] args) {
    int [][] arr = { { 0, 3 }, { 1 }, { 0, 2 },
                     { 2 }, { 0, 1 }, };
    Turtle t = new Turtle(); // step
    for (int i = 0; i < arr.length; i++) { // step
      switch (arr[i][0]) {
        case 0:
          int c = arr[i][1]; // step
          for (int j = 0; j < c; j++) { // step
            t.前に進む(); // step
          }
          break;
        case 1:
          t.右を向く(); // step
          break;
        case 2:
          t.左を向く(); // step
          break;
      }
    }
  }
}
  `,
  twoDimensionalArray3: `
public class Main {
  private static final int FORWARD = 0;
  private static final int TURN_RIGHT = 1;
  private static final int TURN_LEFT = 2;

  public static void main(String[] args) {
    int[][] arr = {
      { FORWARD, 3 },
      { TURN_RIGHT },
      { FORWARD, 2 },
      { TURN_LEFT },
      { FORWARD, 1 }
    };

    Turtle t = new Turtle(); // step
    for (int i = 0; i < arr.length; i++) { // step
      moveTurtle(t, arr[i]); // caller
    }
  }

  private static void moveTurtle(Turtle t, int[] command) {
    switch (command[0]) {
      case FORWARD:
        int steps = command[1]; // step
        for (int j = 0; j < steps; j++) { // step
          t.前に進む(); // step
        }
        break;
      case TURN_RIGHT:
        t.右を向く(); // step
        break;
      case TURN_LEFT:
        t.左を向く(); // step
        break;
    }
  }
}
  `,
  twoDimensionalArray4: `
public class Main {
  private static final int FORWARD = 0;
  private static final int TURN_RIGHT = 1;
  private static final int TURN_LEFT = 2;
  private static final int PUT_TURTLE = 3;

  public static void main(String[] args) {
    int[][] arr = {
      { PUT_TURTLE, 1, 2 },
      { FORWARD, 3 },
      { TURN_RIGHT },
      { FORWARD, 2 },
      { TURN_LEFT },
      { FORWARD, 1 }
    };

    Turtle turtle = null;
    for (int i = 0; i < arr.length; i++) { // step
      int command = arr[i][0]; // step
      switch (command) {
        case PUT_TURTLE:
          turtle = new Turtle(arr[i][1], arr[i][2]); // step
          break;
        case FORWARD:
          int steps = arr[i][1]; // step
          for (int j = 0; j < steps; j++) { // step
            turtle.前に進む(); // step
          }
          break;
        case TURN_RIGHT:
          turtle.右を向く(); // step
          break;
        case TURN_LEFT:
          turtle.左を向く(); // step
          break;
      }
    }
  }
}
  `,
  twoDimensionalArray5: `
public class Main {
  private static final int FORWARD = 0;
  private static final int TURN_RIGHT = 1;
  private static final int TURN_LEFT = 2;
  private static final int PUT_TURTLE = 3;

  public static void main(String[] args) {
    int[][] arr = {
      { PUT_TURTLE, 2, 2 },
      { TURN_RIGHT },
      { FORWARD, 4 },
      { PUT_TURTLE, 6, 0 },
      { FORWARD, 3 },
      { TURN_LEFT },
      { FORWARD, 2 }
    };

    Turtle turtle = null;
    for (int i = 0; i < arr.length; i++) { // step
      int command = arr[i][0]; // step
      switch (command) {
        case PUT_TURTLE:
          // turtle変数が上書きされた場合、ガベージコレクションによって、
          // 元々参照されていた亀が消えるものとする。
          turtle = new Turtle(arr[i][1], arr[i][2]); // step
          break;
        case FORWARD:
          int steps = arr[i][1]; // step
          for (int j = 0; j < steps; j++) { // step
            turtle.前に進む(); // step
          }
          break;
        case TURN_RIGHT:
          turtle.右を向く(); // step
          break;
        case TURN_LEFT:
          turtle.左を向く(); // step
          break;
      }
    }
  }
}
  `,
  twoDimensionalArray6: `
public class Main {
  private static final int FORWARD = 0;
  private static final int TURN_RIGHT = 1;
  private static final int TURN_LEFT = 2;

  public static void main(String[] args) {
    int[][] commands = {
      { FORWARD, FORWARD, FORWARD, FORWARD },
      { FORWARD, FORWARD, TURN_RIGHT, FORWARD, FORWARD },
      { TURN_LEFT, FORWARD, TURN_RIGHT, FORWARD }
    };

    Turtle[] turtles = new Turtle[commands.length];
    for (int nthTurtle = 0; nthTurtle < commands.length; nthTurtle++) { // step
      turtles[nthTurtle] = new Turtle(nthTurtle, 0); // step
    }

    for (int nthTurtle = 0; nthTurtle < commands.length; nthTurtle++) { // step
      for (int i = 0; i < commands[nthTurtle].length; i++) { // step
        int command = commands[nthTurtle][i]; // step
        switch (command) {
          case FORWARD:
            turtles[nthTurtle].前に進む(); // step
            break;
          case TURN_RIGHT:
            turtles[nthTurtle].右を向く(); // step
            break;
          case TURN_LEFT:
            turtles[nthTurtle].左を向く(); // step
            break;
        }
      }
    }
  }
}
  `,
  threeDimensionalArray1: `
public class Main {
  public static void main(String[] args) {
    int[][][] a = { { {0, 0}, {1, 1}, {0, 3} }, // step
                    { {5, 2}, {2, 1}, {0, 4} } };
    Turtle[] turtles = new Turtle[a.length];
    for (int i = 0; i < a.length; i++) { // step
      turtles[i] = new Turtle(a[i][0][0], a[i][0][1]); // step
      for (int j = 1; j < a[i].length; j++) { // step
        int c = a[i][j][1]; // step
        switch (a[i][j][0]) {
          case 0:
            for (int k = 0; k < c; k++) { // step
              turtles[i].前に進む(); // step
            }
            break;
          case 1:
            for (int k = 0; k < c; k++) { // step
              turtles[i].右を向く(); // step
            }
            break;
          case 2:
            for (int k = 0; k < c; k++) { // step
              turtles[i].左を向く(); // step
            }
            break;
        }
      }
    }
  }
}
  `,
  threeDimensionalArray2: `
public class Main {
  private static final int FORWARD = 0;
  private static final int RIGHT = 1;
  private static final int LEFT = 2;

  public static void main(String[] args) {
    int[][][] arr = {
      { {0, 0}, {RIGHT, 1}, {FORWARD, 1} },
      { {3, 1}, {FORWARD, 3}, {RIGHT, 2}, {FORWARD, 1} },
      { {4, 5}, {LEFT, 3}, {FORWARD, 2} },
    };
    Turtle[] turtles = new Turtle[arr.length];
    for (int i = 0; i < arr.length; i++) { // step
      turtles[i] = new Turtle(arr[i][0][0], arr[i][0][1]); // step
      for (int j = 1; j < arr[i].length; j++) { // step
        int command = arr[i][j][0]; // step
        int times = arr[i][j][1]; // step
        switch (command) {
          case FORWARD:
            for (int k = 0; k < times; k++) { // step
              turtles[i].前に進む(); // step
            }
            break;
          case RIGHT:
            for (int k = 0; k < times; k++) { // step
              turtles[i].右を向く(); // step
            }
            break;
          case LEFT:
            for (int k = 0; k < times; k++) { // step
              turtles[i].左を向く(); // step
            }
            break;
        }
      }
    }
  }
}
  `,
  threeDimensionalArray3: `
public class Main {
  private static final int FORWARD = 0;
  private static final int TURN_RIGHT = 1;
  private static final int TURN_LEFT = 2;

  public static void main(String[] args) {
    int[][][] arr = {
      { {0, 0}, {FORWARD, FORWARD, TURN_RIGHT, FORWARD} },
      { {2, 3}, {TURN_LEFT, FORWARD, FORWARD} }
    };
    Turtle[] turtles = new Turtle[arr.length];
    for (int i = 0; i < arr.length; i++) { // step
      turtles[i] = new Turtle(arr[i][0][0], arr[i][0][1]); // step
      for (int j = 0; j < arr[i][1].length; j++) { // step
        int command = arr[i][1][j]; // step
        switch (command) {
          case FORWARD:
            turtles[i].前に進む(); // step
            break;
          case TURN_RIGHT:
            turtles[i].右を向く(); // step
            break;
          case TURN_LEFT:
            turtles[i].左を向く(); // step
            break;
        }
      }
    }
  }
}
  `,
  threeDimensionalArray4: `
public class Main {
  private static final int FORWARD = 0;
  private static final int TURN_RIGHT = 1;
  private static final int TURN_LEFT = 2;

  public static void main(String[] args) {
    int[][][] arr = {
      { {2, 1}, {FORWARD, TURN_LEFT, FORWARD, FORWARD} },
      { {3, 2}, {TURN_RIGHT, FORWARD, TURN_RIGHT} },
      { {1, 3}, {FORWARD, FORWARD, TURN_LEFT, FORWARD, TURN_LEFT} },
      { {3, 3}, {TURN_RIGHT, FORWARD, FORWARD, TURN_RIGHT, FORWARD} }
    };
    Turtle[] turtles = new Turtle[arr.length];
    for (int i = 0; i < arr.length; i++) { // step
      turtles[i] = new Turtle(arr[i][0][0], arr[i][0][1]); // step
      for (int j = 0; j < arr[i][1].length; j++) { // step
        int command = arr[i][1][j]; // step
        switch (command) {
          case FORWARD:
            turtles[i].前に進む(); // step
            break;
          case TURN_RIGHT:
            turtles[i].右を向く(); // step
            break;
          case TURN_LEFT:
            turtles[i].左を向く(); // step
            break;
        }
      }
    }
  }
}
    `,
  // ----------- 初級プログラミングⅡ 第8回 ここまで -----------

  // stepがただの連番である場合、番号を省略できる。
  test1: `
public class Main {
  public static void main(String[] args) {
    Turtle c = new Turtle(); // step
    c.forward(); // step
    c.forward(); // step
    c.forward(); // step
  }
}
`,
  test2: `
public class Main {
  public static void main(String[] args) {
    Turtle c = new Turtle(); // step
    for (int i = 0; i < 2; i++) { // step
      c.forward(); // step
      c.forward(); // step
      c.turnRight(); // step
    }
  }
}
`,
  test3: `
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
  test4: `
public class Main {
  public static void main(String[] args) {
    Turtle c1 = new Turtle(); // step
    c1.forward(); // step
    c1.turnRight(); // step
    int i = 0; // step
    c1.forward(); // step

    Turtle c2 = new Turtle(2, 3, "G"); // step
    c2.forward(); // step
    String foo = "あいうえお"; // step
    int bar = <1-100>; // step
    i = bar + 1; // step
    c2.forward(); // step
    c2.forward(); // step
  }
}
`,
  test5: `
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
  test9: `
public class Main {
  public static void main(String[] args) {
    MyTurtle t1 = new MyTurtle(); // caller
    Settings.speed = 2; // step
    t1.moveForward(); // caller

    MyTurtle2 t2 = new MyTurtle2(2, 2); // caller
    Settings.increaseSpeed(); // caller
    t1.moveForward(); // caller
    t2.moveForward(); // caller
  }
}

class Settings {
  static public int speed;

  public static void increaseSpeed() {
    speed++; // step
  }
}

class MyTurtle {
  private Turtle t = new Turtle(); // step

  void moveForward() {
    for (int i = 0; i < Settings.speed; i++) { // step
      this.t.前に進む(); // step
    }
  }
}

class MyTurtle2 {
  private Turtle t;

  MyTurtle2(int x, int y) {
    this.t = new Turtle(x, y); // step
  }
  void moveForward() {
    for (int i = 0; i < Settings.speed; i++) { // step
      this.t.前に進む(); // step
    }
  }
}
`,
  ...fillInBlankProblemDefinitions,
};

for (const [problemId, program] of Object.entries(problemIdToProgram)) {
  problemIdToProgram[problemId as LegacyProblemId] = program.trim();
}
