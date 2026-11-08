// code-gauge-allow-file duplicateLines 27 -- Each practice family is an independently authored program; sharing their scaffolding would hide what each one teaches.
import type { PracticeDefinition } from './types';

export const beginner2PracticeDefinitions = [
  ...[1, 2, 3].map((value, index) => ({
    id: `practiceEasyV1Beginner2L1IndependentTurnsV${index + 1}`,
    lectureIndex: 0,
    title: `それぞれの向き ${index + 1}`,
    program: independentTurns(value),
  })),
  ...[1, 2, 3].map((value, index) => ({
    id: `practiceEasyV1Beginner2L1AliasTurnV${index + 1}`,
    lectureIndex: 0,
    title: `同じオブジェクト ${index + 1}`,
    program: aliasTurn(value),
  })),
  ...[1, 2, 3].map((value, index) => ({
    id: `practiceEasyV1Beginner2L1ReferenceTargetV${index + 1}`,
    lectureIndex: 0,
    title: `参照先の変更 ${index + 1}`,
    program: referenceTarget(value),
  })),
  ...[1, 2, 3].map((value, index) => ({
    id: `practiceEasyV1Beginner2L2FieldReadV${index + 1}`,
    lectureIndex: 1,
    title: `フィールドの値 ${index + 1}`,
    program: fieldRead(value),
  })),
  ...[1, 2, 3].map((value, index) => ({
    id: `practiceEasyV1Beginner2L2InstanceMethodV${index + 1}`,
    lectureIndex: 1,
    title: `メソッドの呼び出し ${index + 1}`,
    program: instanceMethod(value),
  })),
  ...[1, 2, 3].map((value, index) => ({
    id: `practiceEasyV1Beginner2L2ConstructorFieldV${index + 1}`,
    lectureIndex: 1,
    title: `コンストラクタの値 ${index + 1}`,
    program: constructorField(value),
  })),
  ...[1, 2, 3].map((value, index) => ({
    id: `practiceEasyV1Beginner2L3PublicFieldV${index + 1}`,
    lectureIndex: 2,
    title: `公開フィールド ${index + 1}`,
    program: publicField(value),
  })),
  ...[1, 2, 3].map((value, index) => ({
    id: `practiceEasyV1Beginner2L3AccessorV${index + 1}`,
    lectureIndex: 2,
    title: `値の設定と取得 ${index + 1}`,
    program: accessor(value),
  })),
  ...[-1, 1, 2].map((value, index) => ({
    id: `practiceEasyV1Beginner2L3GuardedSetterV${index + 1}`,
    lectureIndex: 2,
    title: `条件のある設定 ${index + 1}`,
    program: guardedSetter(value),
  })),
  ...[1, 2, 3].map((value, index) => ({
    id: `practiceEasyV1Beginner2L4StaticCallV${index + 1}`,
    lectureIndex: 3,
    title: `静的メソッド ${index + 1}`,
    program: staticCall(value),
  })),
  ...[1, 2, 3].map((value, index) => ({
    id: `practiceEasyV1Beginner2L4StaticFieldV${index + 1}`,
    lectureIndex: 3,
    title: `静的フィールド ${index + 1}`,
    program: staticField(value),
  })),
  ...[1, 2, 3].map((value, index) => ({
    id: `practiceEasyV1Beginner2L4SharedFieldV${index + 1}`,
    lectureIndex: 3,
    title: `共有される値 ${index + 1}`,
    program: sharedField(value),
  })),
  ...[1, 2, 3].map((value, index) => ({
    id: `practiceEasyV1Beginner2L5InheritedMethodV${index + 1}`,
    lectureIndex: 4,
    title: `継承したメソッド ${index + 1}`,
    program: inheritedMethod(value),
  })),
  ...[1, 2, 3].map((value, index) => ({
    id: `practiceEasyV1Beginner2L5OverrideMethodV${index + 1}`,
    lectureIndex: 4,
    title: `上書きしたメソッド ${index + 1}`,
    program: overrideMethod(value),
  })),
  ...[1, 2, 3].map((value, index) => ({
    id: `practiceEasyV1Beginner2L5BaseReferenceV${index + 1}`,
    lectureIndex: 4,
    title: `基本クラスの参照 ${index + 1}`,
    program: baseReference(value),
  })),
  ...[1, 2, 3].map((value, index) => ({
    id: `practiceEasyV1Beginner2L6PackageValueV${index + 1}`,
    lectureIndex: 5,
    title: `パッケージのクラス ${index + 1}`,
    program: packageValue(value),
  })),
  ...[1, 2, 3].map((value, index) => ({
    id: `practiceEasyV1Beginner2L6OverloadCallV${index + 1}`,
    lectureIndex: 5,
    title: `引数のある呼び出し ${index + 1}`,
    program: overloadCall(value),
  })),
  ...[1, 2, 3].map((value, index) => ({
    id: `practiceEasyV1Beginner2L6OverloadDispatchV${index + 1}`,
    lectureIndex: 5,
    title: `型と呼び出し ${index + 1}`,
    program: overloadDispatch(value),
  })),
  ...[1, 2, 3].map((value, index) => ({
    id: `practiceEasyV1Beginner2L7TrySuccessV${index + 1}`,
    lectureIndex: 6,
    title: `try の中の処理 ${index + 1}`,
    program: trySuccess(value),
  })),
  ...[1, 2, 3].map((value, index) => ({
    id: `practiceEasyV1Beginner2L7ExceptionSkipV${index + 1}`,
    lectureIndex: 6,
    title: `例外と後続の処理 ${index + 1}`,
    program: exceptionSkip(value),
  })),
  ...[1, 2, 3].map((value, index) => ({
    id: `practiceEasyV1Beginner2L7CustomExceptionV${index + 1}`,
    lectureIndex: 6,
    title: `独自の例外 ${index + 1}`,
    program: customException(value),
  })),
  ...[1, 2, 3].map((value, index) => ({
    id: `practiceEasyV1Beginner2L8CellReadV${index + 1}`,
    lectureIndex: 7,
    title: `二次元配列の要素 ${index + 1}`,
    program: cellRead(value),
  })),
  ...[1, 2, 3].map((value, index) => ({
    id: `practiceEasyV1Beginner2L8CellUpdateV${index + 1}`,
    lectureIndex: 7,
    title: `二次元配列の更新 ${index + 1}`,
    program: cellUpdate(value),
  })),
  ...[1, 2, 3].map((value, index) => ({
    id: `practiceEasyV1Beginner2L8LayerReadV${index + 1}`,
    lectureIndex: 7,
    title: `三次元配列の要素 ${index + 1}`,
    program: layerRead(value),
  })),
] satisfies PracticeDefinition[];

function independentTurns(value: number): PracticeDefinition['program'] {
  return `
public class Main {
  public static void main(String[] args) {
    Turtle a = new Turtle(${value}, 1);
    Turtle b = new Turtle(${value}, 3);
    a.右を向く();
    b.左を向く();
  }
}

`;
}

function aliasTurn(value: number): PracticeDefinition['program'] {
  return `
public class Main {
  public static void main(String[] args) {
    Turtle t = new Turtle(${value}, 1);
    Turtle alias = t;
    alias.右を向く();
    t.前に進む();
  }
}

`;
}

function referenceTarget(value: number): PracticeDefinition['program'] {
  return `
public class Main {
  public static void main(String[] args) {
    Turtle a = new Turtle(${value}, 1);
    Turtle b = new Turtle(${value}, 3);
    Turtle active = a;
    active = b;
    active.後に戻る();
  }
}

`;
}

function fieldRead(value: number): PracticeDefinition['program'] {
  return `
public class Main {
  public static void main(String[] args) {
    Box b = new Box();
    int x = b.value;
    Turtle t = new Turtle(x, 0);
  }
}
class Box {
  int value = ${value};
}
`;
}

function instanceMethod(value: number): PracticeDefinition['program'] {
  return `
public class Main {
  public static void main(String[] args) {
    Box b = new Box();
    b.increase();
    int x = b.value;
    Turtle t = new Turtle(x, 0);
  }
}
class Box {
  int value = ${value};
  void increase() {
    this.value++;
  }
}
`;
}

function constructorField(value: number): PracticeDefinition['program'] {
  return `
public class Main {
  public static void main(String[] args) {
    Box b = new Box(${value});
    int x = b.value;
    Turtle t = new Turtle(x, 0);
  }
}
class Box {
  int value;
  Box(int value) {
    this.value = value;
  }
}
`;
}

function publicField(value: number): PracticeDefinition['program'] {
  return `
public class Main {
  public static void main(String[] args) {
    Box b = new Box();
    b.value = ${value};
    Turtle t = new Turtle(b.value, 0);
  }
}
class Box {
  public int value = 0;
}
`;
}

function accessor(value: number): PracticeDefinition['program'] {
  return `
public class Main {
  public static void main(String[] args) {
    Box b = new Box();
    b.setValue(${value});
    int x = b.getValue();
    Turtle t = new Turtle(x, 0);
  }
}
class Box {
  private int value = 3;
  public void setValue(int value) {
    this.value = value;
  }
  public int getValue() {
    return this.value;
  }
}
`;
}

function guardedSetter(value: number): PracticeDefinition['program'] {
  return `
public class Main {
  public static void main(String[] args) {
    Box b = new Box();
    b.setValue(${value});
    int x = b.getValue();
    Turtle t = new Turtle(x, 0);
  }
}
class Box {
  private int value = 3;
  public void setValue(int value) {
    if (value >= 0) {
      this.value = value;
    }
  }
  public int getValue() {
    return this.value;
  }
}
`;
}

function staticCall(value: number): PracticeDefinition['program'] {
  return `
public class Main {
  public static void main(String[] args) {
    int x = Coordinate.next(${value});
    Turtle t = new Turtle(x, 0);
  }
}
class Coordinate {
  static int next(int value) {
    return value + 1;
  }
}
`;
}

function staticField(value: number): PracticeDefinition['program'] {
  return `
public class Main {
  public static void main(String[] args) {
    Settings.value = ${value};
    int x = Settings.value;
    Turtle t = new Turtle(x, 0);
  }
}
class Settings {
  static int value = 0;
}
`;
}

function sharedField(value: number): PracticeDefinition['program'] {
  return `
public class Main {
  public static void main(String[] args) {
    Settings a = new Settings();
    Settings b = new Settings();
    a.value = ${value};
    int x = b.value;
    Turtle t = new Turtle(x, 0);
  }
}
class Settings {
  static int value = 0;
}
`;
}

function inheritedMethod(value: number): PracticeDefinition['program'] {
  return `
public class Main {
  public static void main(String[] args) {
    Child b = new Child();
    int x = b.getValue();
    Turtle t = new Turtle(x, 0);
  }
}
class Parent {
  int getValue() {
    return ${value};
  }
}
class Child extends Parent { }
`;
}

function overrideMethod(value: number): PracticeDefinition['program'] {
  return `
public class Main {
  public static void main(String[] args) {
    Child b = new Child();
    int x = b.getValue();
    Turtle t = new Turtle(x, 0);
  }
}
class Parent {
  int getValue() {
    return 0;
  }
}
class Child extends Parent {
  @Override int getValue() {
    return ${value};
  }
}
`;
}

function baseReference(value: number): PracticeDefinition['program'] {
  return `
public class Main {
  public static void main(String[] args) {
    Parent b = new Child();
    int x = b.getValue();
    Turtle t = new Turtle(x, 0);
  }
}
class Parent {
  int getValue() {
    return 0;
  }
}
class Child extends Parent {
  @Override int getValue() {
    return ${value};
  }
}
`;
}

function packageValue(value: number): PracticeDefinition['program'] {
  return `
// Main.java
import coordinates.Coordinate;
public class Main {
  public static void main(String[] args) {
    int x = Coordinate.getValue();
    Turtle t = new Turtle(x, 0);
  }
}
// coordinates/Coordinate.java
package coordinates;
public class Coordinate {
  public static int getValue() {
    return ${value};
  }
}
`;
}

function overloadCall(value: number): PracticeDefinition['program'] {
  return `
public class Main {
  public static void main(String[] args) {
    Parent b = new Parent();
    int x = b.getValue(${value});
    Turtle t = new Turtle(x, 0);
  }
}
class Parent {
  int getValue() {
    return 0;
  }
  int getValue(int value) {
    return value;
  }
}
`;
}

function overloadDispatch(value: number): PracticeDefinition['program'] {
  return `
public class Main {
  public static void main(String[] args) {
    Parent b = new Child();
    int x = b.getValue(${value});
    Turtle t = new Turtle(x, 0);
  }
}
class Parent {
  int getValue() {
    return 0;
  }
  int getValue(int value) {
    return value;
  }
}
class Child extends Parent {
  @Override int getValue(int value) {
    return value + 1;
  }
}
`;
}

function trySuccess(value: number): PracticeDefinition['program'] {
  return `
public class Main {
  public static void main(String[] args) {
    Turtle t = new Turtle(${value}, 1);
    try {
      t.前に進む();
    } catch (RuntimeException e) {
      t.右を向く();
    }
  }
}

`;
}

function exceptionSkip(value: number): PracticeDefinition['program'] {
  return `
public class Main {
  public static void main(String[] args) {
    Turtle t = new Turtle(${value}, 1);
    try {
      Stop.fail();
      t.前に進む();
    } catch (IllegalArgumentException e) {
      t.右を向く();
    }
  }
}
class Stop {
  static void fail() {
    throw new IllegalArgumentException();
  }
}
`;
}

function customException(value: number): PracticeDefinition['program'] {
  return `
public class Main {
  public static void main(String[] args) {
    Turtle t = new Turtle(${value}, 1);
    try {
      throw new Stop();
    } catch (Stop e) {
      t.後に戻る();
    }
  }
}
class Stop extends Exception { }
`;
}

function cellRead(value: number): PracticeDefinition['program'] {
  return `
public class Main {
  public static void main(String[] args) {
    int[][] values = {{0, ${value}}, {0, 0}};
    int x = values[0][1];
    Turtle t = new Turtle(x, 0);
  }
}

`;
}

function cellUpdate(value: number): PracticeDefinition['program'] {
  return `
public class Main {
  public static void main(String[] args) {
    int[][] values = {{0, 0}, {0, 0}};
    values[0][1] = ${value};
    int x = values[0][1];
    Turtle t = new Turtle(x, 0);
  }
}

`;
}

function layerRead(value: number): PracticeDefinition['program'] {
  return `
public class Main {
  public static void main(String[] args) {
    int[][][] values = {{{0}}, {{${value}}}};
    int x = values[1][0][0];
    Turtle t = new Turtle(x, 0);
  }
}

`;
}
