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
        Turtle 亀 = new Turtle();
        亀.前に進む();
        亀.前に進む();
    }
}
    `,
  straight2: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle();
        亀.前に進む();
        亀.前に進む();
        亀.前に進む();
    }
}
    `,
  stepBack: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle();
        亀.前に進む();
        亀.後に戻る();
    }
}
    `,
  stepBack2: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle();
        亀.前に進む();
        亀.前に進む();
        亀.後に戻る();
        亀.前に進む();
        亀.前に進む();
    }
}
    `,
  turnRight: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle();
        亀.前に進む();
        亀.右を向く();
        亀.前に進む();
    }
}
    `,
  turnRight2: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle();
        亀.前に進む();
        亀.前に進む();
        亀.右を向く();
        亀.前に進む();
        亀.前に進む();
    }
}
    `,
  turnLeftAndRight: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle();
        亀.右を向く();
        亀.前に進む();
        亀.左を向く();
        亀.前に進む();
    }
}
    `,
  turnLeftAndRight2: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle();
        亀.前に進む();
        亀.右を向く();
        亀.前に進む();
        亀.左を向く();
        亀.前に進む();
    }
}
    `,
  turnLeftAndRight3: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle();
        亀.右を向く();
        亀.前に進む();
        亀.左を向く();
        亀.前に進む();
        亀.右を向く();
        亀.前に進む();
    }
}
    `,
  turnLeftAndRight4: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle();
        亀.前に進む();
        亀.前に進む();
        亀.右を向く();
        亀.前に進む();
        亀.前に進む();
        亀.左を向く();
        亀.前に進む();
        亀.前に進む();
    }
}
    `,
  square1: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle();
        亀.前に進む();
        亀.右を向く();
        亀.前に進む();
        亀.右を向く();
        亀.前に進む();
    }
}
    `,
  square2: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(<1-5>, <1-4>);
        亀.前に進む();
        亀.右を向く();
        亀.前に進む();
        亀.右を向く();
        亀.前に進む();
    }
}
    `,
  square3: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(<2-5>, <2-5>);
        亀.前に進む();
        亀.左を向く();
        亀.前に進む();
        亀.左を向く();
        亀.前に進む();
        亀.左を向く();
        亀.前に進む();
    }
}
    `,
  square4: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle();
        亀.前に進む();
        亀.前に進む();
        亀.右を向く();
        亀.前に進む();
        亀.前に進む();
        亀.右を向く();
        亀.前に進む();
        亀.前に進む();
        亀.右を向く();
        亀.前に進む();
        亀.前に進む();
    }
}
    `,

  variable: `
public class Main {
    public static void main(String[] args) {
        int x = <1-5>;
        Turtle 亀 = new Turtle(x, <1-5>);
        亀.前に進む();
    }
}
    `,
  variable2: `
public class Main {
    public static void main(String[] args) {
        int a = <2-6>;
        a = a - 1;
        Turtle 亀 = new Turtle(<1-5>, a);
        亀.前に進む();
    }
}
    `,
  variable3: `
public class Main {
    public static void main(String[] args) {
        int x = <1-4>;
        x = x + 1;
        int y = x + 1;
        Turtle 亀 = new Turtle(x, y);
        亀.前に進む();
    }
}
    `,
  variable4: `
public class Main {
    public static void main(String[] args) {
        int b = <1-4>;
        b = b + 1;
        int a = b - 2;
        Turtle 亀 = new Turtle(a + 1, b);
        亀.前に進む();
    }
}
    `,
  variable5: `
public class Main {
    public static void main(String[] args) {
        int x = <1-5>;
        x--;
        int y = x * 2;
        y /= 3;
        Turtle 亀 = new Turtle(x + 1, y + 1);
        亀.前に進む();
    }
}
    `,
  variable6: `
public class Main {
    public static void main(String[] args) {
        int a = <1-3>;
        int b = a * 2;
        int c = b - 2;
        Turtle 亀 = new Turtle(c, b);
        亀.前に進む();
    }
}
    `,
  variable7: `
public class Main {
    public static void main(String[] args) {
        int x = <0-2>;
        int y = (x * 2) + 1;
        int z = (y * 2) + (x / 2);
        x = z / 3;
        Turtle 亀 = new Turtle(x, y);
        亀.前に進む();
    }
}
    `,
  variable8: `
public class Main {
    public static void main(String[] args) {
        int x = <0-2>;
        int y = (x * 3) + 2;
        int z = (y * 2) - (x * 3);
        x = (z / 4) % 7;
        y = (x + y) % 7;
        Turtle 亀 = new Turtle(x, y);
        亀.後に戻る();
    }
}
    `,
  variable9: `
public class Main {
    public static void main(String[] args) {
        int x = <0-3>;
        int y = (x * 4) + 3;
        int z = (y * 3) - (x * 2);
        x = ((z / 5) + x) % 7;
        y = ((x * 2) + y) % 7;
        Turtle 亀 = new Turtle(x, y);
        亀.前に進む();
    }
}
    `,
  variable10: `
public class Main {
    public static void main(String[] args) {
        int x = <0-3>;
        int y = (x * 5) + 4;
        int z = (y * 2) - (x * 3);
        int w = (z + x) % 5;
        x = ((z / 6) + w) % 7;
        y = ((x * 3) + y) % 7;
        Turtle 亀 = new Turtle(x, y);
        亀.前に進む();
    }
}
    `,
  while1: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle();
        int i = 0;
        while (i < <3-5>) {
            亀.前に進む();
            i++;
        }
    }
}
    `,
  while2: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(<0-1>, <0-1>);
        int i = <1-2>;
        while (i < <4-6>) {
            亀.前に進む();
            i++;
        }
    }
}
    `,
  while3: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle();
        int i = 0;
        while (i < <2-3>) {
            i++;
            亀.前に進む();
            亀.右を向く();
        }
    }
}
    `,
  while4: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(<0-1>, <0-1>);
        亀.右を向く();
        int i = <1-2>;
        while (i < <4-5>) {
            亀.前に進む();
            亀.前に進む();
            亀.左を向く();
            i++;
        }
    }
}
    `,
  while5: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle();
        int i = <1-2>;
        while (i < <3-4>) {
            亀.前に進む();
            亀.右を向く();
            亀.前に進む();
            亀.左を向く();
            i++;
        }
    }
}
    `,
  for1: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle();
        for (int i = 0; i < <3-5>; i++) {
            亀.前に進む();
        }
    }
}
    `,
  for2: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(<1-2>, <1-2>);
        for (int i = <1-2>; i < <4-6>; i++) {
            亀.前に進む();
        }
    }
}
    `,
  for3: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle();
        int i = 0;
        for (; i < <2-3>;) {
            亀.前に進む();
            亀.右を向く();
            i++;
        }
    }
}
    `,
  for4: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(<1-2>, <1-2>);
        int i = 1;
        for (; i < <3-4>;) {
            亀.前に進む();
            亀.右を向く();
            i++;
        }
        亀.後に戻る();
    }
}
    `,
  for5: `
public class Main {
    public static void main(String[] args) {
        int x = 0;
        for (int i = 2; i <= <4-5>; i++) {
            x += i;
        }
        x /= 3;
        Turtle 亀 = new Turtle(x + 1, 0);
        亀.前に進む();
    }
}
    `,
  for6: `
public class Main {
    public static void main(String[] args) {
        int a = 0;
        int b = 100;
        for (int i = <4-5>; i > 0; i--) {
            a += i;
            b -= i;
        }
        a /= 4;
        b /= 5;
        Turtle 亀 = new Turtle(a % 6, b % 6);
        亀.前に進む();
    }
}
    `,
  for7: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(3, 3);
        int sum = 0;
        for (int i = 1; i <= <4-6>; i++) {
            sum += i;
            亀.前に進む();
            亀.左を向く();
        }
        for (int i = sum / 4; i >= 0; i--) {
            亀.前に進む();
            亀.前に進む();
            亀.右を向く();
        }
    }
}
    `,
  doubleLoop1: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        for (int i = 0; i < <2-3>; i++) {
            for (int j = 0; j < <2-3>; j++) {
                t.前に進む();
            }
            t.右を向く();
        }
    }
}
    `,
  doubleLoop2: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.右を向く();
        for (int i = 0; i < <2-3>; i++) {
            for (int j = 0; j < <2-3>; j++) {
                t.前に進む();
            }
            t.左を向く();
        }
    }
}
    `,
  doubleLoop3: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        for (int i = <3-4>; i > 0; i--) {
            for (int j = 0; j < i; j++) {
                t.前に進む();
            }
            t.右を向く();
        }
    }
}
    `,
  doubleLoop4: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        for (int i = 3; i > 0; i--) {
            int j = i;
            while (j >= 0) {
                t.前に進む();
                j--;
            }
            t.右を向く();
        }
    }
}
    `,
  doubleLoop5: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        for (int i = 0; i < <3-4>; i++) {
            for (int j = <0-1>; j <= i; j++) {
                t.前に進む();
            }
            t.右を向く();
            for (int k = <0-1>; k < i; k++) {
                t.前に進む();
            }
            t.左を向く();
        }
    }
}
    `,
  if1: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        for (int i = 0; i < <7-9>; i++) {
            t.前に進む();
            if (i % 3 == 2) {
                t.右を向く();
            }
        }
    }
}
    `,
  if2: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(<1-2>, <1-2>);
        t.右を向く();
        for (int i = 0; i < <6-8>; i++) {
            t.前に進む();
            if (i % 3 == 1) {
                t.左を向く();
            }
        }
    }
}
    `,
  if3: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        for (int i = 0; i < <4-5>; i++) {
            t.前に進む();
            if (i % 2 == 0) {
                t.右を向く();
            } else {
                t.左を向く();
            }
        }
    }
}
    `,
  if4: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        for (int i = 0; i < <4-5>; i++) {
            t.前に進む();
            if (i % 3 == 0) {
                t.右を向く();
            } else {
                t.左を向く();
            }
        }
    }
}
    `,
  if5: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        for (int i = 0; i < <3-4>; i++) {
            for (int j = 0; j < <2-3>; j++) {
                if (j % 2 == 0) {
                    t.前に進む();
                } else {
                    t.右を向く();
                }
            }
            t.前に進む();
            t.左を向く();
        }
    }
}
    `,
  elseIf1: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        for (int i = 0; i < <4-6>; i++) {
            if (i < 2)
                t.前に進む();
            else if (i == 2)
                t.左を向く();
            else
                t.後に戻る();
        }
    }
}
    `,
  elseIf2: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        for (int i = 0; i < <5-7>; i++) {
            if (i % 4 == 0)
                t.前に進む();
            else if (i % 4 == 1)
                t.右を向く();
            else if (i % 4 == 2)
                t.前に進む();
            else
                t.左を向く();
        }
    }
}
    `,
  elseIf3: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        for (int i = 0; i < 7; i++) {
            if (i < 2)
                t.前に進む();
            else if (i == 2)
                t.左を向く();
            else if (i == <4-5>)
                t.右を向く();
            else
                t.後に戻る();
        }
    }
}
    `,
  elseIf4: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        for (int i = 0; i < <6-7>; i++) {
            if (i % 5 == 0)
                t.前に進む();
            else if (i % 5 == 1)
                t.左を向く();
            else if (i % 5 == 2)
                t.後に戻る();
            else
                t.右を向く();
        }
    }
}
    `,
  elseIf5: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        for (int i = 0; i < <7-8>; i++) {
            if (i % 5 == 1)
                t.右を向く();
            else if (i % 5 == 3)
                t.左を向く();
            else
                t.前に進む();
        }
    }
}
    `,
  switch1: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        for (int i = 0; i < <5-7>; i++) {
            switch (i) {
                case 0: case 1:
                    t.前に進む(); break;
                case 2:
                    t.左を向く(); break;
                default:
                    t.後に戻る(); break;
            }
        }
    }
}
    `,
  switch2: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        for (int i = 0; i < <5-7>; i++) {
            switch (i % 4) {
                case 1:
                    t.右を向く(); break;
                case 3:
                    t.左を向く(); break;
                default:
                    t.前に進む(); break;
            }
        }
    }
}
    `,
  switch3: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2);
        for (int i = 0; i < <6-7>; i++) {
            switch (i) {
                case 0:
                case 1:
                    t.前に進む();
                    break;
                case 2:
                    t.左を向く();
                    break;
                case 4:
                case 5:
                    t.右を向く();
                    break;
                default:
                    t.後に戻る();
            }
        }
    }
}
    `,
  switch4: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        for (int i = 0; i < <7-8>; i++) {
            switch (i % 5) {
                case 0:
                    t.左を向く();
                    break;
                case 1:
                    t.後に戻る();
                    break;
                case 2:
                    t.右を向く();
                    break;
                default:
                    t.前に進む();
            }
        }
    }
}
    `,
  switch5: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        for (int i = 0; i < <9-10>; i++) {
            switch (i % 6) {
                case 0:
                    t.左を向く();
                    break;
                case 1:
                case 2:
                    t.後に戻る();
                    break;
                case 3:
                    t.右を向く();
                    break;
                default:
                    t.前に進む();
            }
        }
    }
}
    `,
  break1: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        while (true) {
            if (!t.前に進めるか()) break;
            t.前に進む();
        }
    }
}
    `,
  break2: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(<3-4>, <3-4>);
        while (true) {
            if (!t.前に進めるか()) break;
            t.前に進む();
            t.右を向く();

            if (!t.前に進めるか()) break;
            t.前に進む();
            t.左を向く();
        }
    }
}
    `,
  break3: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(<4-6>, <4-6>);
        for (int i = 0; i < 4; i++) {
            for (;;) {
                t.前に進む();
                if (!t.前に進めるか()) break;
            }
            t.右を向く();
        }
    }
}
    `,
  break4: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(<3-5>, <3-5>);
        for (int i = 0; i < 3; i++) {
            while (true) {
                if (!t.前に進めるか()) break;
                t.前に進む();
            }
            t.左を向く();
        }
    }
}
    `,
  break5: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(<4-6>, <4-6>);
        for (int i = 0; i < 3; i++) {
            for (int j = 0; j < 6; j++) {
                if (!t.前に進めるか()) break;
                t.前に進む();
                if (j % 3 == 0) {
                    t.左を向く();
                } else {
                    t.右を向く();
                }
            }
            t.右を向く();
        }
    }
}
    `,
  continue1: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        for (int i = 0; i < <3-5>; i++) {
            if (i == 0) {
                continue;
            }
            t.前に進む();
        }
    }
}
    `,
  continue2: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        for (int i = 0; i < <5-7>; i++) {
            if (i % <2-3> == 1) {
                t.右を向く();
                continue;
            }
            t.前に進む();
        }
    }
}
    `,
  continue3: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        for (int i = 0; i < 2; i++) {
            for (int j = i * 4; j < 8; j++) {
                if (j % 4 == 1) {
                    t.右を向く(); continue;
                } else if (j % 4 == 3) {
                    t.左を向く(); continue;
                }
                t.前に進む();
            }
            t.左を向く();
        }
    }
}
    `,
  continue4: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        for (int i = 0; i < 3; i++) {
            for (int j = i; j < 6; j++) {
                if (j % 2 == 0) {
                    t.右を向く(); continue;
                }
                if (t.前に進めるか()) {
                    t.前に進む();
                }
            }
            t.左を向く();
        }
    }
}
    `,
  continue5: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        for (int i = 0; i < 3; i++) {
            for (int j = i + 1; j < 6; j++) {
                if (j % 4 == 0) {
                    t.左を向く(); continue;
                } else if (j % 3 == 2) {
                    t.右を向く(); continue;
                }
                if (t.前に進めるか()) {
                    t.前に進む();
                }
            }
        }
    }
}
    `,
  method1: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        二歩前に進める(t);
        t.右を向く();
        三歩前に進める(t);
    }
    static void 二歩前に進める(Turtle t) {
        t.前に進む();
        t.前に進む();
    }
    static void 三歩前に進める(Turtle t) {
        t.前に進む();
        t.前に進む();
        t.前に進む();
    }
}
    `,
  method2: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        二歩前に進める(t);
        後ろを向く(t);
        t.前に進む();
    }
    static void 二歩前に進める(Turtle t) {
        t.前に進む();
        t.前に進む();
    }
    static void 後ろを向く(Turtle t) {
        t.右を向く();
        t.右を向く();
    }
}
    `,
  method3: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        N歩前に進める(t, <3-4>);
        t.右を向く();
        N歩前に進める(t, 2);
    }

    static void N歩前に進める(Turtle t, int n) {
        for (int i = 0; i < n; i++) {
            t.前に進む();
        }
    }
}
    `,
  method4: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        二歩前に進める(t);
        t.右を向く();
        四歩前に進める(t);
    }
    static void 二歩前に進める(Turtle t) {
        t.前に進む();
        t.前に進む();
    }
    static void 四歩前に進める(Turtle t) {
        二歩前に進める(t);
        二歩前に進める(t);
    }
}
    `,
  method5: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        正方形を描く(t);
        t.後に戻る();
        t.後に戻る();
        正方形を描く(t);
    }
    static void 正方形を描く(Turtle t) {
        for (int i = 0; i < 3; i++) {
            t.前に進む();
            t.右を向く();
        }
    }
}
    `,
  return1: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        int x = 二倍する(<2-3>);
        N歩前に進める(t, x);
    }
    static void N歩前に進める(Turtle t, int n) {
        for (int i = 0; i < n; i++) {
            t.前に進む();
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
        Turtle t = new Turtle();
        int x = 二倍する(2);
        N歩前に進める(t, x);
        t.右を向く();
        x = 二倍する(x - 1);
        N歩前に進める(t, x);
    }
    static void N歩前に進める(Turtle t, int n) {
        for (int i = 0; i < n; i++) {
            t.前に進む();
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
        Turtle t = new Turtle();
        N歩前に進める(t, 加算する(1, 1));
        N歩前に進める(t, 加算する(1, 2));
    }
    static void N歩前に進める(Turtle t, int n) {
        for (int i = 0; i < n; i++) {
            t.前に進む();
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
        Turtle t = new Turtle();
        for (int i = 0; i < <3-4>; i++) {
            if (偶数か(i)) {
                t.右を向く();
                二歩前に進める(t);
            } else {
                二歩前に進める(t);
                t.右を向く();
                t.右を向く();
            }
        }
    }
    static void 二歩前に進める(Turtle t) {
        t.前に進む();
        t.前に進む();
    }
    static boolean 偶数か(int a) {
        return a % 2 == 0;
    }
}
    `,
  return5: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        for (int i = 0; i < 3; i++) {
            for (int j = 0; j < 3; j++) {
                if (等しいか(i, j))
                    t.右を向く();
                else
                    二歩前に進める(t);
            }
            t.左を向く();
        }
    }
    static void 二歩前に進める(Turtle t) {
        t.前に進む();
        t.前に進む();
    }
    static boolean 等しいか(int a, int b) {
        return a == b;
    }
}
    `,

  array1: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        int[] arr = { 2, <1-2>, <1-2> };
        for (int i = 0; i < arr.length; i++) {
            N歩前に進める(t, arr[i]);
            t.右を向く();
        }
    }
    static void N歩前に進める(Turtle t, int n) {
        for (int i = 0; i < n; i++) {
            t.前に進む();
        }
    }
}
    `,
  array2: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        int[] arr = { <4-5>, <3-4>, <3-4> };
        for (int i = 0; i < arr.length; i++) {
            N歩前に進める(t, arr[i]);
            t.右を向く();
        }
    }
    static void N歩前に進める(Turtle t, int n) {
        for (int i = 0; i < n; i++) {
            t.前に進む();
        }
    }
}
    `,
  array3: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        int[] arr = { 0, 1, 0, 2, 0 };
        for (int i = 0; i < arr.length; i++) {
            switch (arr[i]) {
                case 0:
                    t.前に進む(); break;
                case 1:
                    t.右を向く(); break;
                case 2:
                    t.左を向く(); break;
            }
        }
    }
}
    `,
  array4: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        int[] arr = { 0, 1, 0, 2, 0 };
        for (int cmd : arr) {
            switch (cmd) {
                case 0:
                    t.前に進む(); break;
                case 1:
                    t.右を向く(); break;
                case 2:
                    t.左を向く(); break;
            }
        }
    }
}
    `,
  array5: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        int[] arr = { 0, 1, 0, 2, 0, 3, 0 };
        int steps = 1;
        for (int cmd : arr) {
            switch (cmd) {
                case 0:
                    for (int i = 0; i < steps; i++) {
                        t.前に進む();
                    }
                    break;
                case 1:
                    t.右を向く(); break;
                case 2:
                    t.左を向く(); break;
                case 3:
                    steps++; break;
            }
        }
    }
}
    `,
  string1: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        String s = "frflf";
        for (int i = 0; i < s.length(); i++) {
            switch (s.charAt(i)) {
                case 'f':
                    t.前に進む(); break;
                case 'r':
                    t.右を向く(); break;
                case 'l':
                    t.左を向く(); break;
            }
        }
    }
}
    `,
  string2: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        String s = "ffbrfl";
        for (int i = 0; i < s.length(); i++) {
            switch (s.charAt(i)) {
                case 'f':
                    t.前に進む(); break;
                case 'r':
                    t.右を向く(); break;
                case 'l':
                    t.左を向く(); break;
                case 'b':
                    t.後に戻る(); break;
            }
        }
    }
}
    `,
  string3: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        String s = "frflf";
        for (char ch : s.toCharArray()) {
            switch (ch) {
                case 'f':
                    t.前に進む(); break;
                case 'r':
                    t.右を向く(); break;
                case 'l':
                    t.左を向く(); break;
            }
        }
    }
}
    `,
  string4: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        String[] cmds = { "ri", "aa", "fo" };
        for (String cmd : cmds) {
            t.前に進む();
            parse(t, cmd);
        }
    }
    static void parse(Turtle t, String c) {
        if (c.equals("fo"))
            t.前に進む();
        else if (c.equals("ri"))
            t.右を向く();
    }
}
    `,
  string5: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        String[] cmds = { "ri", "add", "fo", "add", "le", "fo", "fo" };
        int x = 0;
        for (String cmd : cmds) {
            parse(t, cmd, x);
            if (cmd.equals("add")) {
                x++;
            }
        }
    }
    static void parse(Turtle t, String c, int x) {
        if (c.equals("fo"))
            N歩前に進める(t, x);
        else if (c.equals("ri"))
            t.右を向く();
        else if (c.equals("le"))
            t.左を向く();
    }
    static void N歩前に進める(Turtle t, int n) {
        for (int i = 0; i < n; i++) {
            t.前に進む();
        }
    }
}
    `,
  oop1: `
public class Main {
  public static void main(String[] args) {
    Turtle t1 = new Turtle(1, 1);
    Turtle t2 = new Turtle(3, 3);
    t1.前に進む();
    t2.前に進む();
    t1.前に進む();
    t2.前に進む();
  }
}
`,
  oop2: `
public class Main {
  public static void main(String[] args) {
    MyTurtle m = new MyTurtle(0, 0, 2);
    m.forward();
  }
}

class MyTurtle {
  private int speed;
  private Turtle c;
  public MyTurtle(int x, int y, int speed) {
    this.speed = speed;
    this.c = new Turtle(x, y);
  }
  public void forward() {
    for (int i = 0; i < this.speed; i++) {
      this.c.前に進む();
    }
  }
}
`,
  // ----------- 初級プログラミングⅡ 第1回 ここから -----------
  multiObject1: `
public class Main {
  public static void main(String[] args) {
    Turtle t1 = new Turtle(1, 1);
    Turtle t2 = new Turtle(3, 3);
    t1.前に進む();
    t1.右を向く();
    t2.前に進む();
    t2.左を向く();
  }
}
`,
  multiObject2: `
public class Main {
  public static void main(String[] args) {
    Turtle t1 = new Turtle(1, 1);
    t1.前に進む();
    t1.右を向く();
    Turtle t2 = new Turtle(3, 3);
    t2.前に進む();
    t2.左を向く();
    t2.前に進む();
  }
}
`,
  multiObject3: `
public class Main {
  public static void main(String[] args) {
    Turtle t1 = new Turtle(1, 4);
    Turtle t2 = new Turtle(5, 4);
    Turtle t3 = new Turtle(2, 1);

    t1.右を向く();
    t1.右を向く();
    t1.前に進む();

    t2.左を向く();
    t2.左を向く();
    t2.前に進む();

    t3.右を向く();
    t3.前に進む();
    t3.前に進む();
  }
}
`,
  multiObject4: `
public class Main {
  public static void main(String[] args) {
    Turtle t1 = new Turtle(0, 6);
    Turtle t2 = new Turtle(6, 0);

    t1.右を向く();
    t1.右を向く();

    for (int i = 0; i < 5; i++) {
      t1.前に進む();
      t2.前に進む();
      if (i % 2 == 0) {
        t1.左を向く();
        t2.左を向く();
      } else {
        t1.右を向く();
        t2.右を向く();
      }
    }
  }
}
`,
  multiObject5: `
public class Main {
  public static void main(String[] args) {
    Turtle t1 = new Turtle(0, 3);
    Turtle t2 = new Turtle(4, 3);
    Turtle t3 = new Turtle(0, 0);
    Turtle t4 = new Turtle(1, 6);
    Turtle t5 = new Turtle(6, 4);

    t1.右を向く();

    while (t1.前に進めるか()) {
      while (t1.前に進めるか()) {
        t1.前に進む();
      }
      t1.右を向く();
    }
  }
}
`,
  multiObject6: `
public class Main {
  public static void main(String[] args) {
    Turtle[] turtles = new Turtle[3];
    for (int i = 0; i < turtles.length; i++) {
      turtles[i] = new Turtle(1 + i * 2, 0);
    }

    for (int i = 0; i < 3; i++) {
      for (int j = 0; j < turtles.length; j++) {
        N歩前に進める(turtles[j], j);
      }
    }
  }

  static void N歩前に進める(Turtle t, int n) { // atomic
    for (int i = 0; i < n; i++) {
      t.前に進む();
    }
  }
}
`,
  garbageCollection1: `
public class Main {
  public static void main(String[] args) {
    Turtle t1 = new Turtle(1, 1);
    t1.前に進む();
    t1.右を向く();
    Turtle t2 = new Turtle(3, 3);
    t2.前に進む();
    // ガベージコレクションで亀が消えることとする。
    t2 = t1;
    t2.前に進む();
  }
}
`,
  garbageCollection2: `
public class Main {
  public static void main(String[] args) {
  Turtle t1 = new Turtle(1, 1);
  Turtle t2 = new Turtle(3, 3);
  Turtle t3 = new Turtle(5, 5);

  t1.前に進む();
  t2.前に進む();
  t3.前に進む();

  // ガベージコレクションで亀が消えることとする。
  t2 = t1;
  // ガベージコレクションで亀が消えることとする。
  t3 = t2;

  t3.前に進む();
  t2.前に進む();
  t1.前に進む();
  }
}
`,
  garbageCollection3: `
public class Main {
  public static void main(String[] args) {
    Turtle[] turtles = new Turtle[2];
    turtles[0] = new Turtle(2, 3);
    turtles[1] = new Turtle(3, 4);

    for (int i = 0; i < turtles.length; i++)
      N回右を向く(turtles[i], i);
    for (int i = 0; i < turtles.length; i++)
      N回前に進む(turtles[i], 3);

    // ガベージコレクションで亀が消えることとする。
    turtles[0] = new Turtle(4, 3);
    // ガベージコレクションで亀が消えることとする。
    turtles[1] = new Turtle(3, 2);

    for (int i = 0; i < turtles.length; i++)
      N回左を向く(turtles[i], i);
    for (int i = 0; i < turtles.length; i++)
      N回前に進む(turtles[i], 3);
  }

  static void N回前に進む(Turtle t, int n) { // atomic
    for (int i = 0; i < n; i++) t.前に進む();
  }
  static void N回右を向く(Turtle t, int n) { // atomic
    for (int i = 0; i < n; i++) t.右を向く();
  }
  static void N回左を向く(Turtle t, int n) { // atomic
    for (int i = 0; i < n; i++) t.左を向く();
  }
}
`,
  garbageCollection4: `
public class Main {
  public static void main(String[] args) {
    Turtle[] turtles = new Turtle[5];
    for (int i = 0; i < turtles.length; i++) {
      turtles[i] = new Turtle(i, 0);
    }

    for (int i = 0; i < turtles.length; i++) {
      // nullは、何も参照していないことを示す特別な値。
      // ガベージコレクションで亀が消えることとする。
      turtles[i] = null;

      for (Turtle t : turtles) {
        if (t != null) {
          t.前に進む();
        }
      }
    }
  }
}
`,
  garbageCollection5: `
public class Main {
  public static void main(String[] args) {
    線を描く(1, 1, 1, 5);
    線を描く(1, 5, 2, 5);
    Turtle t = new Turtle(3, 3);
  }

  static void 線を描く(int x, int y, int dir, int len) {
    Turtle t = new Turtle(x, y);
    for (int i = 0; i < dir; i++) {
      t.右を向く();
    }
    for (int i = 0; i < len - 1; i++) {
      t.前に進む();
    }
    // 線を描く()メソッドが終わると変数tはなくなり、亀も消えることとする。
  }
}
`,
  garbageCollection6: `
public class Main {
  public static void main(String[] args) {
    正方形を描く(0, 0, 6);
    正方形を描く(3, 3, 3);
    Turtle t = new Turtle(3, 3);
  }

  static void 正方形を描く(int x, int y, int size) {
    線を描く(x, y, 0, size);
    線を描く(x, y + size, 1, size);
    線を描く(x + size, y + size, 2, size);
    線を描く(x + size, y, 3, size);
  }

  static void 線を描く(int x, int y, int dir, int len) {
    Turtle t = new Turtle(x, y);
    for (int i = 0; i < dir; i++) {
      t.右を向く();
    }
    for (int i = 0; i < len - 1; i++) {
      t.前に進む();
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
    MyTurtle t = new MyTurtle();
    t.moveForward();
    t.speed = 1;
    t.moveForward();
  }
}

class MyTurtle {
  Turtle t = new Turtle();
  int speed = 2;

  void moveForward() {
    for (int i = 0; i < this.speed; i++) {
      this.t.前に進む();
    }
  }
}
    `,
  makeClass2: `
public class Main {
  public static void main(String[] args) {
    MyTurtle t = new MyTurtle();
    t.moveDiagonally();
    t.speed = 2;
    t.moveDiagonally();
  }
}

class MyTurtle {
  Turtle t = new Turtle();
  int speed = 1;

  void moveDiagonally() {
    for (int i = 0; i < this.speed; i++) {
      this.t.前に進む();
      this.t.右を向く();
      this.t.前に進む();
      this.t.左を向く();
    }
  }
}
    `,
  makeClass3: `
public class Main {
  public static void main(String[] args) {
    MyTurtle t = new MyTurtle();
    t.drawSquare();
    t.size = 4;
    t.drawSquare();
  }
}

class MyTurtle {
  Turtle t = new Turtle();
  int size = 2;

  void drawSquare() {
    for (int i = 0; i < this.size * 4; i++) {
      if (i % this.size == this.size - 1) {
        this.t.右を向く();
      } else {
        this.t.前に進む();
      }
    }
  }
}
    `,
  makeClass4: `
public class Main {
  public static void main(String[] args) {
    MyTurtle t = new MyTurtle();
    t.moveForward();
    t.speed = 1;
    t.turnRight();
    t.moveForward();
  }
}
class MyTurtle {
  Turtle fast = new Turtle(1, 1);
  Turtle slow = new Turtle(5, 1);
  int speed = 2;

  void moveForward() {
    for (int i = 0; i < this.speed; i++) {
      this.fast.前に進む();
      this.fast.前に進む();
      this.slow.前に進む();
    }
  }
  void turnRight() {
    this.fast.右を向く();
    this.slow.右を向く();
  }
}
    `,
  makeClass5: `
public class Main {
  public static void main(String[] args) {
    MyTurtle t = new MyTurtle();
    t.operate();
    t.operation = "LFFRFF";
    t.operate();
  }
}
class MyTurtle {
  Turtle t = new Turtle();
  String operation = "FFRFF";

  void operate() {
    for (int i = 0; i < this.operation.length(); i++) {
      switch (this.operation.charAt(i)) {
        case 'F':
          this.t.前に進む(); break;
        case 'R':
          this.t.右を向く(); break;
        case 'L':
          this.t.左を向く(); break;
      }
    }
  }
}
`,
  makeClass6: `
public class Main {
  public static void main(String[] args) {
    MyTurtle t = new MyTurtle();
    t.turnRight();
    t.moveForward();
    t.turnLeft();
    t.moveForward();
    t.moveForward();
  }
}
class MyTurtle {
  Turtle t = new Turtle();
  int speed = 1;
  void moveForward() {
    for (int i = 0; i < this.speed; i++)
      this.t.前に進む();
    speed++;
  }
  void turnRight() {
    this.t.右を向く();
  }
  void turnLeft() {
    this.t.左を向く();
  }
}
`,
  constructor1: `
public class Main {
  public static void main(String[] args) {
    MyTurtle t = new MyTurtle(0, 1, 2);
    t.moveForward();
    t.speed = 1;
    t.moveForward();
  }
}

class MyTurtle {
  Turtle t;
  int speed;

  MyTurtle(int x, int y, int speed) {
    this.t = new Turtle(x, y);
    this.speed = speed;
  }
  void moveForward() {
    for (int i = 0; i < this.speed; i++) {
      this.t.前に進む();
    }
  }
}
    `,
  constructor2: `
public class Main {
  public static void main(String[] args) {
    MyTurtle t = new MyTurtle(1, 1, "FRFLFFF");
    t.operate();
  }
}
class MyTurtle {
  Turtle t;
  String operation;

  MyTurtle(int x, int y, String operation) {
    this.t = new Turtle(x, y);
    this.operation = operation;
  }
  void operate() {
    for (int i = 0; i < this.operation.length(); i++) {
      switch (this.operation.charAt(i)) {
      case 'F':
        this.t.前に進む(); break;
      case 'R':
        this.t.右を向く(); break;
      case 'L':
        this.t.左を向く(); break;
      }
    }
  }
}
`,
  constructor3: `
public class Main {
  public static void main(String[] args) {
    MyTurtle t = new MyTurtle(2);
    t.moveForward();
    t.turnRight();
    t.moveForward();
    t.moveForward();
    t.turnLeft();
  }
}
class MyTurtle {
  Turtle t;
  int speed;

  MyTurtle(int speed) {
    this.t = new Turtle();
    this.speed = speed;
  }
  void moveForward() {
    for (int i = 0; i < this.speed; i++)
      this.t.前に進む();
    this.speed--;
  }
  void turnRight() {
    this.t.右を向く();
  }
  void turnLeft() {
    this.t.左を向く();
  }
}
`,
  constructor4: `
public class Main {
  public static void main(String[] args) {
    Turtle t1 = new Turtle(3, 4);
    Turtle t2 = new Turtle(0, 0);
    TurtleMover mover = new TurtleMover(t1);
    mover.moveSquare(3);
    mover.t = new Turtle(3, 1);
    mover.moveSquare(3);
    mover.t = t2; // ガベージコレクションで亀が消えることとする。
    mover.moveSquare(2);
  }
}
class TurtleMover {
  Turtle t;

  TurtleMover(Turtle t) {
    this.t = t;
  }
  void moveSquare(int size) {
    for (int i = 0; i < size * 4; i++) {
      if (i % size == size - 1) {
        this.t.右を向く();
      } else {
        this.t.前に進む();
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
    MyTurtle t = new MyTurtle();
    t.moveForward();
    t.changeSpeed(1);
    t.moveForward();
  }
}

class MyTurtle {
  private Turtle t = new Turtle();
  private int speed = 2;

  public void moveForward() {
    for (int i = 0; i < this.speed; i++) {
      this.t.前に進む();
    }
  }
  public void changeSpeed(int speed) {
    this.speed = speed;
  }
}
`,
  withoutEncapsulation: `
public class Main {
  public static void main(String[] args) {
    Turtle t = new Turtle();
    drawSquare(t, 2);
    drawSquare(t, 3);
  }

  static void drawSquare(Turtle t, int size) {
    for (int i = 0; i < 4; i++) {
      for (int j = 0; j < size - 1; j++) {
        t.前に進む();
      }
      t.右を向く();
    }
  }
}
`,
  withEncapsulation: `
public class Main {
  public static void main(String[] args) {
    SquareTurtle t = new SquareTurtle();
    t.draw(2);
    t.draw(3);
  }
}

class SquareTurtle {
  private Turtle t = new Turtle(0, 0);

  void draw(int size) {
    for (int i = 0; i < 4; i++) {
      for (int j = 0; j < size - 1; j++) {
        this.t.前に進む();
      }
      this.t.右を向く();
    }
  }
}
`,
  withoutEncapsulation2: `
public class Main {
  public static void main(String[] args) {
    Turtle t = new Turtle();
    drawCurve(t, 3);
  }
  static void drawCurve(Turtle t, int speed) {
    drawLine(t, speed);
    t.右を向く();
    drawLine(t, speed);
  }
  static void drawLine(Turtle t, int speed) {
    for (int i = 0; i < speed; i++) {
      t.前に進む();
    }
  }
}
`,
  withEncapsulation2: `
public class Main {
  public static void main(String[] args) {
    CurveTurtle t = new CurveTurtle();
    t.draw(2);
  }
}
class CurveTurtle {
  private Turtle t = new Turtle(0, 0);
  void draw(int speed) {
    this.drawLine(speed);
    this.t.右を向く();
    this.drawLine(speed);
  }
  void drawLine(int speed) {
    for (int i = 0; i < speed; i++) {
      this.t.前に進む();
    }
  }
}
`,
  withEncapsulation3: `
public class Main {
  public static void main(String[] args) {
    MyTurtle t = new MyTurtle(0, 0, 1);
    t.moveForward();
    t.moveForward();
    // 以下ではガベージコレクションで亀が消えることとする。
    t = new MyTurtle(2, 2, t.getSpeed() * 2);
    t.moveForward();
  }
}

class MyTurtle {
  private Turtle t;
  private int speed;

  MyTurtle(int x, int y, int speed) {
    this.t = new Turtle(x, y);
    this.speed = speed;
  }
  public int getSpeed() {
    return this.speed;
  }
  public void moveForward() {
    for (int i = 0; i < this.speed; i++) {
      this.t.前に進む();
    }
  }
}
`,
  withEncapsulation4: `
public class Main {
  public static void main(String[] args) {
    MyTurtle t = new MyTurtle(0, 0, 2);
    t.moveForward();
    t.setSpeed(t.getSpeed() * 3 / 2);
    t.moveForward();
    t.setSpeed(-1);
    t.moveForward();
    t.setSpeed(99);
    t.moveBackward();
  }
}

class MyTurtle {
  private Turtle t;
  private int speed;

  MyTurtle(int x, int y, int speed) {
    this.t = new Turtle(x, y);
    this.setSpeed(speed);
  }
  public int getSpeed() {
    return this.speed;
  }
  public void setSpeed(int speed) {
    if (speed < 0)      this.speed = 0;
    else if (5 < speed) this.speed = 5;
    else                this.speed = speed;
  }
  public void moveForward() {
    for (int i = 0; i < this.speed; i++)
      this.t.前に進む();
  }
  public void moveBackward() {
    for (int i = 0; i < this.speed; i++)
      this.t.後に戻る();
  }
}
`,
  withEncapsulation5: `
public class Main {
  public static void main(String[] args) {
    MyTurtle t = new MyTurtle(3, 0, 3);
    t.moveForward();
    t.changeSpeed(-2);
    t.moveForward();
    t.changeSpeed(5);
    t.moveForward();
  }
}

class MyTurtle {
  private Turtle t;
  private int speed;

  MyTurtle(int x, int y, int speed) {
    this.t = new Turtle(x, y);
    this.speed = speed;
  }
  public void moveForward() {
    // Math.abs(this.speed)は、this.speedの絶対値を返す。
    for (int i = 0; i < Math.abs(this.speed); i++) {
      this.t.前に進む();
    }
  }
  public void changeSpeed(int speed) {
    if (this.speed * speed < 0) {
      this.t.右を向く();
      this.t.右を向く();
    }
    this.speed = speed;
  }
}
`,
  withEncapsulation6: `
public class Main {
  public static void main(String[] args) {
    MyTurtle t = new MyTurtle(3, 3);
    t.moveForward();
    t.moveForward();
    t.teleport(0, 0);
    t.moveForward();
    t.teleport(6, 6);
  }
}

class MyTurtle {
  private Turtle t;

  MyTurtle(int x, int y) {
    this.t = new Turtle(x, y);
  }
  public void moveForward() {
    this.t.前に進む();
  }
  public void teleport(int x, int y) {
    // ガベージコレクションで元々の亀が消えることとする。
    this.t = new Turtle(x, y);
  }
}
`,
  withEncapsulation7: `
public class Main {
  public static void main(String[] args) {
    MyTurtle t = new MyTurtle(0, 0);
    t.setOperation("FFRFR");
    t.operate();
    t.setOperation("ABC");
    t.operate();
  }
}
class MyTurtle {
  private Turtle t;
  private String operation;

  MyTurtle(int x, int y) {
    this.t = new Turtle(x, y);
    this.operation = "F";
  }
  public void setOperation(String op) {
    this.operation = op;
  }
  public void operate() {
    for (int i = 0; i < this.operation.length(); i++) {
      switch (this.operation.charAt(i)) {
        case 'F':
          this.t.前に進む(); break;
        case 'B':
          this.t.後に戻る(); break;
        case 'R':
          this.t.右を向く(); break;
        case 'L':
          this.t.左を向く(); break;
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
    Turtle t1 = new Turtle(1, 1);
    Controller.moveTwoSteps(t1);
    Turtle t2 = new Turtle(3, 3);
    Controller.moveTwoSteps(t2);
  }
}

class Controller {
  static void moveTwoSteps(Turtle t) {
    t.前に進む();
    t.前に進む();
  }
}
    `,
  staticMethod2: `
public class Main {
  public static void main(String[] args) {
    Turtle t1 = new Turtle(1, 1);
    Turtle t2 = new Turtle(3, 3);
    Controller.moveTwoSteps(t1);
    Controller.moveTwoSteps(t2);
    t1.前に進む();
  }
}

class Controller {
  static void moveTwoSteps(Turtle t) {
    t.前に進む();
    t.前に進む();
  }
}
    `,
  staticMethod3: `
public class Main {
    public static void main(String[] args) {
    Turtle t1 = new Turtle(0, 0);
    Controller.moveThreeSteps(t1);
    Turtle t2 = new Turtle(3, 0);
    Turtle t3 = new Turtle(6, 0);
    Controller.moveThreeSteps(t2);
    Controller.moveThreeSteps(t3);
  }
}

class Controller {
  static void moveThreeSteps(Turtle t) {
    t.前に進む();
    t.前に進む();
    t.前に進む();
  }
}
    `,
  staticMethod4: `
public class Main {
  public static void main(String[] args) {
    Turtle t1 = new Turtle(0, 0);
    Turtle t2 = new Turtle(1, 1);
    Controller.drawSquare(t1, 4);
    Turtle t3 = new Turtle(2, 2);
    Controller.drawSquare(t2, 3);
    Controller.drawSquare(t3, 2);
  }
}

class Controller {
  static void drawSquare(Turtle t, int size) {
    for (int i = 0; i < 4; i++) {
      Controller.drawLine(t, size - 1);
      t.右を向く();
    }
  }
  static void drawLine(Turtle t, int n) {
    for (int i = 0; i < n; i++)
      t.前に進む();
  }
}
    `,
  staticField1: `
public class Main {
  public static void main(String[] args) {
    Turtle t1 = new Turtle(1, 1);
    Controller.moveTwoSteps(t1);
    Turtle t2 = new Turtle(3, 3);
    Controller.moveTwoSteps(t2);
    int count = Controller.stepCount;
  }
}

class Controller {
  static int stepCount;

  static void moveTwoSteps(Turtle t) {
    t.前に進む();
    stepCount++;
    t.前に進む();
    stepCount++;
  }
}
    `,
  staticField2: `
public class Main {
  public static void main(String[] args) {
    MyTurtle t1 = new MyTurtle();
    t1.moveForward();
    Settings.speed = 2;
    MyTurtle t2 = new MyTurtle();
    t1.moveForward();
    t2.moveForward();
  }
}

class Settings {
  static public int speed = 3;
}

class MyTurtle {
  private Turtle t = new Turtle();

  void moveForward() {
    for (int i = 0; i < Settings.speed; i++) {
      this.t.前に進む();
    }
  }
}
`,
  staticField3: `
public class Main {
  public static void main(String[] args) {
    LineTurtle t1 = new LineTurtle();
    SquareTurtle t2 = new SquareTurtle();
    t1.drawLine();
    t2.drawSquare();
    Settings.speed = 3;
    t1.drawLine();
  }
}
class Settings {
  static public int speed = 2;
}
class LineTurtle {
  private Turtle t = new Turtle(0, 0);
  void drawLine() {
    for (int i = 0; i < Settings.speed; i++)
      t.前に進む();
  }
}
class SquareTurtle {
  private Turtle t = new Turtle(1, 1);
  void drawSquare() {
    for (int i = 0; i < 4; i++) {
      for (int j = 0; j < Settings.speed; j++)
        t.前に進む();
      t.右を向く();
    }
  }
}
    `,
  staticField4: `
public class Main {
  public static void main(String[] args) {
    AcceleratedTurtle t1 = new AcceleratedTurtle();
    SquareTurtle t2 = new SquareTurtle();
    t1.drawLine();
    t2.drawSquare();
    Settings.speed = 2;
    t1.drawLine();
  }
}
class Settings {
  static public int speed = 2;
}
class AcceleratedTurtle {
  private Turtle t = new Turtle(0, 0);
  void drawLine() {
    for (int i = 0; i < Settings.speed; i++)
      t.前に進む();
    Settings.speed++;
  }
}
class SquareTurtle {
  private Turtle t = new Turtle(1, 1);
  void drawSquare() {
    for (int i = 0; i < 4; i++) {
      for (int j = 0; j < Settings.speed; j++)
        t.前に進む();
      t.右を向く();
    }
  }
}
    `,
  staticField5: `
public class Main {
  public static void main(String[] args) {
    SlowTurtle t1 = new SlowTurtle();
    FastTurtle t2 = new FastTurtle();
    t1.moveForward();
    t2.moveForward();
    Settings.additionalSpeed++;
    t1.moveForward();
    t2.moveForward();
  }
}
class Settings {
  static public int additionalSpeed = 0;
}
class SlowTurtle {
  private Turtle t = new Turtle(0, 0);
  private int base = 1;
  void moveForward() {
    for (int i = 0; i < this.base + Settings.additionalSpeed; i++)
      t.前に進む();
  }
}
class FastTurtle {
  private Turtle t = new Turtle(6, 0);
  private int base = 2;
  void moveForward() {
    for (int i = 0; i < this.base + Settings.additionalSpeed; i++)
      t.前に進む();
  }
}
    `,
  staticField6: `
public class Main {
  public static void main(String[] args) {
    MyTurtle t1 = new MyTurtle(0, 0);
    MyTurtle t2 = new MyTurtle(3, 0);
    t1.moveForward();
    t2.moveForward();
    t1.base++;
    Settings.additionalSpeed++;
    t1.moveForward();
    t2.moveForward();
  }
}
class Settings {
  static public int additionalSpeed = 0;
}
class MyTurtle {
  private Turtle turtle;
  public int base;

  MyTurtle(int x, int y) {
    this.turtle = new Turtle(x, y);
    this.base = 1;
  }
  void moveForward() {
    for (int i = 0; i < this.base + Settings.additionalSpeed; i++)
      this.turtle.前に進む();
  }
}
    `,
  // ----------- 初級プログラミングⅡ 第4回 ここまで -----------

  // ----------- 初級プログラミングⅡ 第5回 ここから -----------
  inheritance1: `
public class Main {
  public static void main(String[] args) {
    CurveTurtle t = new CurveTurtle();
    t.drawCurve();
  }
}
class MyTurtle {
  Turtle t = new Turtle();

  void drawLine() {
    this.t.前に進む();
    this.t.前に進む();
  }
}
class CurveTurtle extends MyTurtle {
  void drawCurve() {
    this.drawLine();
    this.t.右を向く();
    this.drawLine();
  }
}
`,
  inheritance2: `
public class Main {
  public static void main(String[] args) {
    CurveTurtle t = new CurveTurtle(2);
    t.drawCurve();
  }
}
class MyTurtle {
  Turtle t;
  MyTurtle(int x, int y) {
    this.t = new Turtle(x, y);
  }
  void drawLine() {
    this.t.前に進む();
    this.t.前に進む();
  }
}
class CurveTurtle extends MyTurtle {
  CurveTurtle(int p) {
    super(p, p);
  }
  void drawCurve() {
    this.drawLine();
    this.t.右を向く();
    this.drawLine();
  }
}
`,
  inheritance3: `
public class Main {
  public static void main(String[] args) {
    CurveTurtle t = new CurveTurtle(0);
    t.drawCurve();
    t.drawLine();
  }
}
class MyTurtle {
  Turtle t;
  MyTurtle(int x, int y) {
    this.t = new Turtle(x, y);
  }
  void drawLine() {
    this.t.前に進む();
    this.t.前に進む();
  }
}
class CurveTurtle extends MyTurtle {
  CurveTurtle(int p) {
    super(p + 1, p + 2);
  }
  void drawCurve() {
    this.drawLine();
    this.t.右を向く();
    this.drawLine();
  }
}
    `,
  inheritance4: `
public class Main {
  public static void main(String[] args) {
    SquareTurtle t = new SquareTurtle();
    t.drawSquare();
  }
}
class MyTurtle {
  Turtle t = new Turtle(0, 1);
  void drawLine() {
    this.t.前に進む();
    this.t.前に進む();
  }
}
class CurveTurtle extends MyTurtle {
  void drawCurve() {
    this.drawLine();
    this.t.右を向く();
    this.drawLine();
  }
}
class SquareTurtle extends CurveTurtle {
  void drawSquare() {
    this.drawCurve();
    this.t.右を向く();
    this.drawCurve();
  }
}
    `,
  override1: `
public class Main {
  public static void main(String[] args) {
    FastTurtle t = new FastTurtle();
    t.drawLine();
  }
}
class MyTurtle {
  Turtle t = new Turtle();

  void drawLine() {
    for (int i = 0; i < this.length(); i++) {
      this.t.前に進む();
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
    SuperFastTurtle t = new SuperFastTurtle();
    t.drawLine();
  }
}
class MyTurtle {
  Turtle t = new Turtle();
  void drawLine() {
    for (int i = 0; i < this.length(); i++) {
      this.t.前に進む();
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
    FastCurveTurtle t = new FastCurveTurtle();
    t.draw();
  }
}
class MyTurtle {
  Turtle t = new Turtle();
  void draw() {
    for (int i = 0; i < this.length(); i++) {
      this.t.前に進む();
    }
  }
  int length() {
    return 2;
  }
}
class FastCurveTurtle extends MyTurtle {
  @Override void draw() {
    // 親クラス (MyTurtle) の draw() を呼び出す。
    super.draw();
    this.t.右を向く();
    // 親クラス (MyTurtle) の draw() を呼び出す。
    super.draw();
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
      new MyTurtle(0, 0),
      new FastTurtle(1)
    };
    for (int i = 0; i < ts.length; i++) {
      ts[i].drawLine();
    }
  }
}
class MyTurtle {
  Turtle t;
  MyTurtle(int x, int y) {
    this.t = new Turtle(x, y);
  }
  void drawLine() {
    for (int i = 0; i < this.length(); i++) {
      this.t.前に進む();
    }
  }
  int length() { return 2; }
}
class FastTurtle extends MyTurtle {
  FastTurtle(int p) {
    super(p, p);
  }
  @Override int length() { return 3; }
}
`,
  polymorphism2: `
public class Main {
  public static void main(String[] args) {
    MyTurtle[] ts = {
      new FastTurtle(3),
      new CurveTurtle(0)
    };
    for (int i = 0; i < ts.length; i++) {
      ts[i].draw();
    }
  }
}
class MyTurtle {
  Turtle t;
  MyTurtle(int x, int y) {
    this.t = new Turtle(x, y);
  }
  void draw() {
    for (int i = 0; i < this.length(); i++) {
      this.t.前に進む();
    }
  }
  int length() { return 2; }
}
class FastTurtle extends MyTurtle {
  FastTurtle(int p) {
    super(p, p);
  }
  @Override int length() { return 3; }
}
class CurveTurtle extends MyTurtle {
  CurveTurtle(int p) {
    super(p, p + 1);
  }
  @Override void draw() {
    // 親クラス (MyTurtle) の draw() を呼び出す。
    super.draw();
    this.t.右を向く();
    // 親クラス (MyTurtle) の draw() を呼び出す。
    super.draw();
  }
}
`,
  polymorphism3: `
public class Main {
  public static void main(String[] args) {
    MyTurtle[] ts = {
      new MyTurtle(0, 0),
      new FastTurtle(3),
      new CurveTurtle(2)
    };
    for (int i = 0; i < ts.length; i++) {
      ts[i].draw();
      ts[i].t.右を向く();
      ts[i].draw();
    }
  }
}
class MyTurtle {
  Turtle t;
  MyTurtle(int x, int y) {
    this.t = new Turtle(x, y);
  }
  void draw() {
    for (int i = 0; i < this.length(); i++) {
      this.t.前に進む();
    }
  }
  int length() { return 2; }
}
class FastTurtle extends MyTurtle {
  FastTurtle(int p) {
    super(p, p);
  }
  @Override int length() { return 3; }
}
class CurveTurtle extends MyTurtle {
  CurveTurtle(int p) {
    super(p, p + 1);
  }
  @Override void draw() {
    // 親クラス (MyTurtle) の draw() を呼び出す。
    super.draw();
    this.t.右を向く();
    // 親クラス (MyTurtle) の draw() を呼び出す。
    super.draw();
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
    FastTurtle fast = new FastTurtle();
    fast.drawLine();
  }
}
// -------------- Main.java ここまで --------------

// -------- turtle/MyTurtle.java ここから --------
package turtle;
public class MyTurtle {
  private Turtle t = new Turtle();
  public void drawLine() {
    for (int i = 0; i < this.length(); i++)
      this.t.前に進む();
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
    BoldLineTurtle t = new BoldLineTurtle();
    t.draw();
  }
}
// -------------- Main.java ここまで --------------

// -------- turtle/LineTurtle.java ここから --------
package turtle;
public class LineTurtle {
  protected Turtle t = new Turtle();
  public void draw() {
    for (int i = 0; i < 3; i++)
      this.forward();
  }
  protected void forward() {
  	this.t.前に進む();
  }
}
// -------- turtle/LineTurtle.java ここまで --------

// ------- turtle/BoldLineTurtle.java ここから -------
package turtle;
public class BoldLineTurtle extends LineTurtle {
  @Override protected void forward() {
		this.t.右を向く();
		this.t.前に進む();
		this.t.左を向く();
		this.t.前に進む();
		this.t.左を向く();
		this.t.前に進む();
		this.t.右を向く();
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
      new LineTurtle(0, 0),
      new LongLineTurtle(3, 0)
    };
    for (LineTurtle t : ts)
      t.draw();
  }
}
// -------------- Main.java ここまで --------------

// -------- turtle/LineTurtle.java ここから --------
package turtle;
public class LineTurtle {
  protected Turtle t;
  public LineTurtle(int x, int y) {
    this.t = new Turtle(x, y);
  }
  public void draw() {
    for (int i = 0; i < 3; i++)
      this.forward();
  }
  protected void forward() {
  	this.t.前に進む();
  }
}
// -------- turtle/LineTurtle.java ここまで --------

// ------- turtle/LongLineTurtle.java ここから -------
package turtle;
public class LongLineTurtle extends LineTurtle {
  public LongLineTurtle(int x, int y) {
    super(x, y);
  }
  @Override protected void forward() {
		this.t.前に進む();
		this.t.前に進む();
  }
}
// ------- turtle/LongLineTurtle.java ここまで -------
`,
  overload1: `
public class Main {
  public static void main(String[] args) {
    CurveTurtle t = new CurveTurtle();
    t.drawCurve();
  }
}
class MyTurtle {
  Turtle t = new Turtle();
  void drawLine(int steps) {
    for (int i = 0; i < steps; i++)
      this.t.前に進む();
  }
  void drawLine() {
    this.drawLine(2);
  }
}
class CurveTurtle extends MyTurtle {
  void drawCurve() {
    this.drawLine(3);
    this.t.右を向く();
    this.drawLine();
  }
}
    `,
  overload2: `
public class Main {
  public static void main(String[] args) {
    MyTurtle t = new MyTurtle();
    t.operate(0);
    t.operate("right");
    t.operate("up");
    t.operate(1);
    t.operate(0);
  }
}
class MyTurtle {
  private Turtle t = new Turtle(0, 0);
  public void operate(int n) {
    if (n == 0) {
      this.t.前に進む();
    } else if (n == 1) {
      this.t.右を向く();
      this.t.前に進む();
      this.t.左を向く();
    }
  }
  public void operate(String s) {
    if (s.equals("up")) {
      operate(0);
    } else if (s.equals("right")) {
      operate(1);
    }
  }
}
    `,
  overload3: `
public class Main {
  public static void main(String[] args) {
    MyTurtle t = new MyTurtle();
    t.drawLine(max(2, 3));
    t.t.右を向く();
    t.drawLine(max(2, 3, 4));
    t.t.右を向く();
    t.drawLine(max(2, 1));
    t.t.右を向く();
    t.drawLine(max(3, 2, 1));
    t.t.右を向く();
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
  public Turtle t = new Turtle();
  public void drawLine(int steps) {
    for (int i = 0; i < steps; i++)
      this.t.前に進む();
  }
}
    `,
  overload4: `
public class Main {
  public static void main(String[] a) {
    MyTurtle t = new MyTurtle();
    t.move(2);
    t.move(1, 3);
    t.move(-3);
    t.move(-1, 0);
    t.move(4, 2);
    t.move(0, -4);
  }
}
public class MyTurtle {
  private Turtle t = new Turtle(0, 0);
  public void move(int dy) {
    while (dy > 0) {
      dy--;
      this.t.前に進む();
    }
    while (dy < 0) {
      dy++;
      this.t.後に戻る();
    }
  }
  public void move(int dx, int dy) {
    move(dy);
    if (dx != 0) {
      this.t.右を向く();
      while (dx > 0) {
        dx--;
        this.t.前に進む();
      }
      while (dx < 0) {
        dx++;
        this.t.後に戻る();
      }
      this.t.左を向く();
    }
  }
}
`,
  overloadAndOverride1: `
public class Main {
  public static void main(String[] args) {
    MyTurtle m2 = new MyTurtle2();
    m2.drawLine();
    MyTurtle m3 = new MyTurtle3();
    m3.drawLine();
    MyTurtle[] ms = { m2, m3 };
    for (MyTurtle m : ms) {
      m.t.右を向く();
      m.drawLine();
    }
  }
}
class MyTurtle {
  Turtle t = new Turtle();
  void drawLine(int steps) {
    for (int i = 0; i < steps; i++)
      this.t.前に進む();
  }
  void drawLine() {
    this.drawLine(2);
  }
}
class MyTurtle2 extends MyTurtle {
  @Override void drawLine() {
    this.drawLine(4);
  }
}
class MyTurtle3 extends MyTurtle {
  @Override void drawLine() {
    this.drawLine(3);
  }
}
    `,
  overloadAndOverride2: `
public class Main {
  public static void main(String[] args) {
    MyTurtle m2 = new MyTurtle2();
    m2.drawLine(2);
    MyTurtle m3 = new MyTurtle3();
    m3.drawLine(1);
    MyTurtle[] ms = { m2, m3 };
    for (MyTurtle m : ms) {
      m.t.右を向く();
      m.drawLine();
    }
  }
}
class MyTurtle {
  Turtle t = new Turtle();
  void drawLine(int steps) {
    for (int i = 0; i < steps; i++)
      this.t.前に進む();
  }
  void drawLine() {
    this.drawLine(2);
  }
}
class MyTurtle2 extends MyTurtle {
  @Override void drawLine() {
    this.drawLine(3);
  }
}
class MyTurtle3 extends MyTurtle {
  @Override void drawLine() {
    this.drawLine(4);
  }
}
    `,
  overloadAndOverride3: `
public class Main {
  public static void main(String[] args) {
    MyTurtle m1 = new MyTurtle();
    m1.drawLine(4);
    MyTurtle m2 = new MyTurtle2();
    m2.drawLine(3);
    MyTurtle m3 = new MyTurtle3();
    m3.drawLine(1);
    MyTurtle[] ms = { m1, m2, m3 };
    for (MyTurtle m : ms) {
      m.t.右を向く();
      m.drawLine();
    }
  }
}
class MyTurtle {
  Turtle t = new Turtle();
  void drawLine(int steps) {
    for (int i = 0; i < steps; i++)
      this.t.前に進む();
  }
  void drawLine() {
    this.drawLine(2);
  }
}
class MyTurtle2 extends MyTurtle {
  @Override void drawLine() {
    this.drawLine(3);
  }
}
class MyTurtle3 extends MyTurtle2 {
  @Override void drawLine(int steps) {
    // MyTurtleクラスの "drawLine(int steps)" を呼ぶ。
    super.drawLine(steps * 2);
  }
}
    `,
  // ----------- 初級プログラミングⅡ 第6回 ここまで -----------

  // ----------- 初級プログラミングⅡ 第7回 ここから -----------
  exception1: `
public class Main {
  public static void main(String[] args) {
    MyTurtle m = new MyTurtle();
    try {
      m.drawLine();
      m.drawLine();
    } catch (Exception e) {
      m.t.右を向く();
      m.t.前に進む();
    }
  }
}

class MyTurtle {
  public Turtle t = new Turtle();

  public void drawLine() {
    for (int i = 0; i < 4; i++) {
      if (!t.前に進めるか()) {
        throw new RuntimeException("前に進めない！");
      }
      this.t.前に進む();
    }
  }
}
    `,
  exception2: `
public class Main {
  public static void main(String[] args) {
    MyTurtle m = new MyTurtle();
    try {
      m.drawLine();
      m.drawLine();
    } catch (ArithmeticException e) {
      m.t.右を向く();
      m.t.前に進む();
    }
  }
}

class MyTurtle {
  public Turtle t = new Turtle();

  public void drawLine() {
    for (int i = 0; i < 4; i++) {
      if (!t.前に進めるか()) {
        throw new RuntimeException("前に進めない！");
      }
      this.t.前に進む();
    }
  }
}
`,
  exception3: `
public class Main {
  public static void main(String[] args) {
    MyTurtle m = new MyTurtle();
    try {
      m.drawLine();
      m.drawLine();
    } catch (Exception e) {
      m.t.右を向く();
      m.t.前に進む();
      m.t.左を向く();
    }
  }
}

class MyTurtle {
  public Turtle t = new Turtle();

  public void drawLine() {
    for (int i = 0; i < 4; i++) {
      if (!t.前に進めるか()) {
        throw new RuntimeException("前に進めない！");
      }
      this.t.前に進む();
    }
  }
}
`,
  exception4: `
public class Main {
  public static void main(String[] args) {
    MyTurtle m = new MyTurtle();
    try {
      m.drawLine();
      m.drawLine();
    } catch (Exception e) {
      m.t.前に進む();
      m.t.右を向く();
    }
  }
}

class MyTurtle {
  public Turtle t = new Turtle();

  public void drawLine() {
    try {
      for (int i = 0; i < 4; i++) {
        if (!t.前に進めるか()) {
          throw new RuntimeException("前に進めない！");
        }
        this.t.前に進む();
      }
    } catch (RuntimeException e) {
      t.右を向く();
      throw e; // catchした例外をもう一度throwする。
    }
  }
}
`,
  exception5: `
public class Main {
  public static void main(String[] args) {
    MyTurtle m = new MyTurtle();
    try {
      m.drawLine();
      m.drawLine();
    } catch (RuntimeException e) {
      m.t.前に進む();
      throw e; // catchした例外をもう一度throwする。
    }
  }
}

class MyTurtle {
  public Turtle t = new Turtle();

  public void drawLine() {
    try {
      for (int i = 0; i < 4; i++) {
        if (!t.前に進めるか()) {
          throw new RuntimeException("前に進めない！");
        }
        this.t.前に進む();
      }
    } catch (RuntimeException e) {
      t.右を向く();
      throw e; // catchした例外をもう一度throwする。
    }
  }
}
`,
  originalException1: `
public class Main {
  public static void main(String[] args) {
    MyTurtle m = new MyTurtle();
    m.drawLine();
    m.drawLine();
  }
}

class OutOfBoardException extends Exception { }

class MyTurtle {
  public Turtle t = new Turtle();

  public void drawLine() {
    try {
      for (int i = 0; i < 4; i++) {
        if (!this.t.前に進めるか()) {
          throw new OutOfBoardException();
        }
        this.t.前に進む();
      }
    } catch (Exception e) {
      this.t.右を向く();
      this.t.前に進む();
    }
  }
}
`,
  originalException2: `
public class Main {
  public static void main(String[] args) {
    MyTurtle m = new MyTurtle();
    try {
      m.drawLine();
      m.drawLine();
    } catch (OutOfBoardException e) {
      m.t.右を向く();
      m.t.前に進む();
    }
  }
}

class MyTurtle {
  public Turtle t = new Turtle();

  public void drawLine() throws OutOfBoardException {
    for (int i = 0; i < 4; i++) {
      if (!this.t.前に進めるか()) {
        throw new OutOfBoardException();
      }
      this.t.前に進む();
    }
  }
}

class OutOfBoardException extends Exception { }
`,
  originalException3: `
public class Main {
  public static void main(String[] args) {
    MyTurtle m = new MyTurtle();
    try {
      m.drawSquare();
    } catch (OutOfBoardException e) {
      m.t.右を向く();
      m.t.前に進む();
    } catch (ColoredException e) {
      m.t.前に進む();
      m.t.左を向く();
    }
  }
}

class OutOfBoardException extends Exception { }
class ColoredException extends Exception { }

class MyTurtle {
  public Turtle t = new Turtle();

  public void drawSquare()
        throws OutOfBoardException, ColoredException {
    for (int i = 0; i < 4; i++) {
      if (!this.t.前に進めるか()) {
        throw new OutOfBoardException();
      }
      if (this.t.前のマスが塗られているか()) {
        throw new ColoredException();
      }
      this.t.前に進む();
      this.t.右を向く();
    }
  }
}
`,
  originalException4: `
public class Main {
  public static void main(String[] args) {
    MyTurtle m = new MyTurtle();
    try {
      m.drawSquare();
    } catch (Exception e) {
      m.t.左を向く();
      m.t.左を向く();
      m.t.前に進む();
    }
  }
}

class OutOfBoardException extends Exception { }
class ColoredException extends Exception { }

class MyTurtle {
  public Turtle t = new Turtle(5, 4);

  public void drawSquare()
        throws OutOfBoardException, ColoredException {
    for (int i = 0; i < 4; i++) {
      for (int j = 0; j < 2; j++) {
        if (!this.t.前に進めるか()) {
          throw new OutOfBoardException();
        }
        if (this.t.前のマスが塗られているか()) {
          throw new ColoredException();
        }
        this.t.前に進む();
      }
      this.t.右を向く();
    }
  }
}
`,
  originalException5: `
public class Main {
  public static void main(String[] args) {
    MyTurtle m = new MyTurtle();
    for (int n = 0; n < 3; n++) {
      try {
        m.drawSquare(n + 1);
      } catch (OutOfBoardException e) {
        m.t.右を向く();
        m.t.右を向く();
      } catch (ColoredException e) {
        m.t.前に進む();
        m.t.前に進む();
      }
    }
  }
}

class OutOfBoardException extends Exception { }
class ColoredException extends Exception { }

class MyTurtle {
  public Turtle t = new Turtle(5, 5);

  public void drawSquare(int size)
        throws OutOfBoardException, ColoredException {
    for (int i = 0; i < 4; i++) {
      for (int j = 0; j < size; j++) {
        if (!this.t.前に進めるか()) {
          throw new OutOfBoardException();
        }
        if (this.t.前のマスが塗られているか()) {
          throw new ColoredException();
        }
        this.t.前に進む();
      }
      this.t.右を向く();
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
    Turtle t = new Turtle();
    for (int i = 0; i < arr.length; i++) {
      int c = arr[i][1];
      switch (arr[i][0]) {
        case 0:
          for (int j = 0; j < c; j++) {
            t.前に進む();
          }
          break;
        case 1:
          for (int j = 0; j < c; j++) {
            t.右を向く();
          }
          break;
        case 2:
          for (int j = 0; j < c; j++) {
            t.左を向く();
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
    Turtle t = new Turtle();
    for (int i = 0; i < arr.length; i++) {
      switch (arr[i][0]) {
        case 0:
          int c = arr[i][1];
          for (int j = 0; j < c; j++) {
            t.前に進む();
          }
          break;
        case 1:
          t.右を向く();
          break;
        case 2:
          t.左を向く();
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

    Turtle t = new Turtle();
    for (int i = 0; i < arr.length; i++) {
      moveTurtle(t, arr[i]);
    }
  }

  private static void moveTurtle(Turtle t, int[] command) {
    switch (command[0]) {
      case FORWARD:
        int steps = command[1];
        for (int j = 0; j < steps; j++) {
          t.前に進む();
        }
        break;
      case TURN_RIGHT:
        t.右を向く();
        break;
      case TURN_LEFT:
        t.左を向く();
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
    for (int i = 0; i < arr.length; i++) {
      int command = arr[i][0];
      switch (command) {
        case PUT_TURTLE:
          turtle = new Turtle(arr[i][1], arr[i][2]);
          break;
        case FORWARD:
          int steps = arr[i][1];
          for (int j = 0; j < steps; j++) {
            turtle.前に進む();
          }
          break;
        case TURN_RIGHT:
          turtle.右を向く();
          break;
        case TURN_LEFT:
          turtle.左を向く();
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
    for (int i = 0; i < arr.length; i++) {
      int command = arr[i][0];
      switch (command) {
        case PUT_TURTLE:
          // turtle変数が上書きされた場合、ガベージコレクションによって、
          // 元々参照されていた亀が消えるものとする。
          turtle = new Turtle(arr[i][1], arr[i][2]);
          break;
        case FORWARD:
          int steps = arr[i][1];
          for (int j = 0; j < steps; j++) {
            turtle.前に進む();
          }
          break;
        case TURN_RIGHT:
          turtle.右を向く();
          break;
        case TURN_LEFT:
          turtle.左を向く();
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
    for (int nthTurtle = 0; nthTurtle < commands.length; nthTurtle++) {
      turtles[nthTurtle] = new Turtle(nthTurtle, 0);
    }

    for (int nthTurtle = 0; nthTurtle < commands.length; nthTurtle++) {
      for (int i = 0; i < commands[nthTurtle].length; i++) {
        int command = commands[nthTurtle][i];
        switch (command) {
          case FORWARD:
            turtles[nthTurtle].前に進む();
            break;
          case TURN_RIGHT:
            turtles[nthTurtle].右を向く();
            break;
          case TURN_LEFT:
            turtles[nthTurtle].左を向く();
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
    int[][][] a = { { {0, 0}, {1, 1}, {0, 3} },
                    { {5, 2}, {2, 1}, {0, 4} } };
    Turtle[] turtles = new Turtle[a.length];
    for (int i = 0; i < a.length; i++) {
      turtles[i] = new Turtle(a[i][0][0], a[i][0][1]);
      for (int j = 1; j < a[i].length; j++) {
        int c = a[i][j][1];
        switch (a[i][j][0]) {
          case 0:
            for (int k = 0; k < c; k++) {
              turtles[i].前に進む();
            }
            break;
          case 1:
            for (int k = 0; k < c; k++) {
              turtles[i].右を向く();
            }
            break;
          case 2:
            for (int k = 0; k < c; k++) {
              turtles[i].左を向く();
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
    for (int i = 0; i < arr.length; i++) {
      turtles[i] = new Turtle(arr[i][0][0], arr[i][0][1]);
      for (int j = 1; j < arr[i].length; j++) {
        int command = arr[i][j][0];
        int times = arr[i][j][1];
        switch (command) {
          case FORWARD:
            for (int k = 0; k < times; k++) {
              turtles[i].前に進む();
            }
            break;
          case RIGHT:
            for (int k = 0; k < times; k++) {
              turtles[i].右を向く();
            }
            break;
          case LEFT:
            for (int k = 0; k < times; k++) {
              turtles[i].左を向く();
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
    for (int i = 0; i < arr.length; i++) {
      turtles[i] = new Turtle(arr[i][0][0], arr[i][0][1]);
      for (int j = 0; j < arr[i][1].length; j++) {
        int command = arr[i][1][j];
        switch (command) {
          case FORWARD:
            turtles[i].前に進む();
            break;
          case TURN_RIGHT:
            turtles[i].右を向く();
            break;
          case TURN_LEFT:
            turtles[i].左を向く();
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
    for (int i = 0; i < arr.length; i++) {
      turtles[i] = new Turtle(arr[i][0][0], arr[i][0][1]);
      for (int j = 0; j < arr[i][1].length; j++) {
        int command = arr[i][1][j];
        switch (command) {
          case FORWARD:
            turtles[i].前に進む();
            break;
          case TURN_RIGHT:
            turtles[i].右を向く();
            break;
          case TURN_LEFT:
            turtles[i].左を向く();
            break;
        }
      }
    }
  }
}
    `,
  // ----------- 初級プログラミングⅡ 第8回 ここまで -----------

  test1: `
public class Main {
  public static void main(String[] args) {
    Turtle c = new Turtle();
    c.forward();
    c.forward();
    c.forward();
  }
}
`,
  test2: `
public class Main {
  public static void main(String[] args) {
    Turtle c = new Turtle();
    for (int i = 0; i < 2; i++) {
      c.forward();
      c.forward();
      c.turnRight();
    }
  }
}
`,
  test3: `
public class Main {
  public static void main(String[] args) {
    int a = 1;
    if (a > 0) {
      int b = 2;
      a = f(a, b);
    }
    int c = a * 2;
  }

  public static int f(int x, int y) {
    int a = x * y;
    return a;
  }
}
`,
  test4: `
public class Main {
  public static void main(String[] args) {
    Turtle c1 = new Turtle();
    c1.forward();
    c1.turnRight();
    int i = 0;
    c1.forward();

    Turtle c2 = new Turtle(2, 3, "G");
    c2.forward();
    String foo = "あいうえお";
    int bar = <1-100>;
    i = bar + 1;
    c2.forward();
    c2.forward();
  }
}
`,
  test5: `
public class Straight {
  public static void main(String[] args) {
    var c = new Turtle();
    c.前に進む();
    c.前に進む();
    c.右を向く();
    c.前に進む();
    c.前に進む();
    c.前に進む();
    c.前に進む();
  }
}
`,
  test9: `
public class Main {
  public static void main(String[] args) {
    MyTurtle t1 = new MyTurtle();
    Settings.speed = 2;
    t1.moveForward();

    MyTurtle2 t2 = new MyTurtle2(2, 2);
    Settings.increaseSpeed();
    t1.moveForward();
    t2.moveForward();
  }
}

class Settings {
  static public int speed;

  public static void increaseSpeed() {
    speed++;
  }
}

class MyTurtle {
  private Turtle t = new Turtle();

  void moveForward() {
    for (int i = 0; i < Settings.speed; i++) {
      this.t.前に進む();
    }
  }
}

class MyTurtle2 {
  private Turtle t;

  MyTurtle2(int x, int y) {
    this.t = new Turtle(x, y);
  }
  void moveForward() {
    for (int i = 0; i < Settings.speed; i++) {
      this.t.前に進む();
    }
  }
}
`,
  ...fillInBlankProblemDefinitions,
};

for (const [problemId, program] of Object.entries(problemIdToProgram)) {
  problemIdToProgram[problemId as LegacyProblemId] = program.trim();
}
