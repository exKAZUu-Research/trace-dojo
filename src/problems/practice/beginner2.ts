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
  return {
    java: `
public class Main {
  public static void main(String[] args) {
    Turtle a = new Turtle(${value}, 1); // step
    Turtle b = new Turtle(${value}, 3); // step
    a.右を向く(); // step
    b.左を向く(); // step
  }
}

`,
    instrumented: `
function main() {
  const a = new Turtle(${value}, 1); registerDisplayRef('a', () => a); // step
  const b = new Turtle(${value}, 3); registerDisplayRef('b', () => b); // step
  a.右を向く(); // step
  b.左を向く(); // step
}

main();
`,
  };
}

function aliasTurn(value: number): PracticeDefinition['program'] {
  return {
    java: `
public class Main {
  public static void main(String[] args) {
    Turtle t = new Turtle(${value}, 1); // step
    Turtle alias = t; // step
    alias.右を向く(); // step
    t.前に進む(); // step
  }
}

`,
    instrumented: `
function main() {
  const t = new Turtle(${value}, 1); registerDisplayRef('t', () => t); // step
  const alias = t; registerDisplayRef('alias', () => alias); // step
  alias.右を向く(); // step
  t.前に進む(); // step
}

main();
`,
  };
}

function referenceTarget(value: number): PracticeDefinition['program'] {
  return {
    java: `
public class Main {
  public static void main(String[] args) {
    Turtle a = new Turtle(${value}, 1); // step
    Turtle b = new Turtle(${value}, 3); // step
    Turtle active = a; // step
    active = b; // step
    active.後に戻る(); // step
  }
}

`,
    instrumented: `
function main() {
  const a = new Turtle(${value}, 1); registerDisplayRef('a', () => a); // step
  const b = new Turtle(${value}, 3); registerDisplayRef('b', () => b); // step
  let active = a; registerDisplayRef('active', () => active); // step
  active = b; // step
  active.後に戻る(); // step
}

main();
`,
  };
}

function fieldRead(value: number): PracticeDefinition['program'] {
  return {
    java: `
public class Main {
  public static void main(String[] args) {
    Box b = new Box(); // caller
    int x = b.value; // step
    Turtle t = new Turtle(x, 0); // step
  }
}
class Box {
  int value = ${value}; // step
}
`,
    instrumented: `
function main() {
  const b = call(Box)(); registerDisplayRef('b', () => b);
  s.set('x', b.value);
  const t = new Turtle(s.get('x'), 0); registerDisplayRef('t', () => t); // step
}
class Box {
  constructor() {
    this.value = ${value}; // step
  }
}
main();
`,
  };
}

function instanceMethod(value: number): PracticeDefinition['program'] {
  return {
    java: `
public class Main {
  public static void main(String[] args) {
    Box b = new Box(); // caller
    b.increase(); // caller
    int x = b.value; // step
    Turtle t = new Turtle(x, 0); // step
  }
}
class Box {
  int value = ${value}; // step
  void increase() {
    this.value++; // step
  }
}
`,
    instrumented: `
function main() {
  const b = call(Box)(); registerDisplayRef('b', () => b);
  call(b.increase.bind(b))();
  s.set('x', b.value);
  const t = new Turtle(s.get('x'), 0); registerDisplayRef('t', () => t); // step
}
class Box {
  constructor() {
    this.value = ${value}; // step
  }
  increase() {
    this.value++; // step
  }
}
main();
`,
  };
}

function constructorField(value: number): PracticeDefinition['program'] {
  return {
    java: `
public class Main {
  public static void main(String[] args) {
    Box b = new Box(${value}); // caller
    int x = b.value; // step
    Turtle t = new Turtle(x, 0); // step
  }
}
class Box {
  int value;
  Box(int value) {
    this.value = value; // step
  }
}
`,
    instrumented: `
function main() {
  const b = call(Box, 'value')(${value}); registerDisplayRef('b', () => b);
  s.set('x', b.value);
  const t = new Turtle(s.get('x'), 0); registerDisplayRef('t', () => t); // step
}
class Box {
  constructor(value) {
    this.value = value; // step
  }
}
main();
`,
  };
}

function publicField(value: number): PracticeDefinition['program'] {
  return {
    java: `
public class Main {
  public static void main(String[] args) {
    Box b = new Box(); // caller
    b.value = ${value}; // step
    Turtle t = new Turtle(b.value, 0); // step
  }
}
class Box {
  public int value = 0; // step
}
`,
    instrumented: `
function main() {
  const b = call(Box)(); registerDisplayRef('b', () => b);
  b.value = ${value}; // step
  const t = new Turtle(b.value, 0); registerDisplayRef('t', () => t); // step
}
class Box {
  constructor() {
    this.value = 0; // step
  }
}
main();
`,
  };
}

function accessor(value: number): PracticeDefinition['program'] {
  return {
    java: `
public class Main {
  public static void main(String[] args) {
    Box b = new Box(); // caller
    b.setValue(${value}); // caller
    int x = b.getValue(); // step // caller
    Turtle t = new Turtle(x, 0); // step
  }
}
class Box {
  private int value = 3; // step
  public void setValue(int value) {
    this.value = value; // step
  }
  public int getValue() {
    return this.value;
  }
}
`,
    instrumented: `
function main() {
  const b = call(Box)(); registerDisplayRef('b', () => b);
  call(b.setValue.bind(b), 'value')(${value});
  s.set('x', call(b.getValue.bind(b))());
  const t = new Turtle(s.get('x'), 0); registerDisplayRef('t', () => t); // step
}
class Box {
  constructor() {
    this.value = 3; // step
  }
  setValue(value) {
    this.value = value; // step
  }
  getValue() {
    return this.value;
  }
}
main();
`,
  };
}

function guardedSetter(value: number): PracticeDefinition['program'] {
  return {
    java: `
public class Main {
  public static void main(String[] args) {
    Box b = new Box(); // caller
    b.setValue(${value}); // caller
    int x = b.getValue(); // step // caller
    Turtle t = new Turtle(x, 0); // step
  }
}
class Box {
  private int value = 3; // step
  public void setValue(int value) {
    if (value >= 0) {
      this.value = value; // step
    }
  }
  public int getValue() {
    return this.value;
  }
}
`,
    instrumented: `
function main() {
  const b = call(Box)(); registerDisplayRef('b', () => b);
  call(b.setValue.bind(b), 'value')(${value});
  s.set('x', call(b.getValue.bind(b))());
  const t = new Turtle(s.get('x'), 0); registerDisplayRef('t', () => t); // step
}
class Box {
  constructor() {
    this.value = 3; // step
  }
  setValue(value) {
    if (value >= 0) {
      this.value = value; // step
    }
  }
  getValue() {
    return this.value;
  }
}
main();
`,
  };
}

function staticCall(value: number): PracticeDefinition['program'] {
  return {
    java: `
public class Main {
  public static void main(String[] args) {
    int x = Coordinate.next(${value}); // step // caller
    Turtle t = new Turtle(x, 0); // step
  }
}
class Coordinate {
  static int next(int value) {
    return value + 1;
  }
}
`,
    instrumented: `
function main() {
  s.set('x', call(Coordinate.next, 'value')(${value}));
  const t = new Turtle(s.get('x'), 0); registerDisplayRef('t', () => t); // step
}
class Coordinate {
  static next(value) {
    return value + 1;
  }
}
main();
`,
  };
}

function staticField(value: number): PracticeDefinition['program'] {
  return {
    java: `
public class Main {
  public static void main(String[] args) {
    Settings.value = ${value}; // step
    int x = Settings.value; // step
    Turtle t = new Turtle(x, 0); // step
  }
}
class Settings {
  static int value = 0;
}
`,
    instrumented: `
function main() {
  Settings.value = ${value}; // step
  s.set('x', Settings.value);
  const t = new Turtle(s.get('x'), 0); registerDisplayRef('t', () => t); // step
}
class Settings {
  static value = 0;
}
main();
`,
  };
}

function sharedField(value: number): PracticeDefinition['program'] {
  return {
    java: `
public class Main {
  public static void main(String[] args) {
    Settings a = new Settings(); // caller
    Settings b = new Settings(); // caller
    a.value = ${value}; // step
    int x = b.value; // step
    Turtle t = new Turtle(x, 0); // step
  }
}
class Settings {
  static int value = 0;
}
`,
    instrumented: `
function main() {
  const a = call(Settings)(); registerDisplayRef('a', () => a);
  const b = call(Settings)(); registerDisplayRef('b', () => b);
  Settings.value = ${value}; // step
  s.set('x', Settings.value);
  const t = new Turtle(s.get('x'), 0); registerDisplayRef('t', () => t); // step
}
class Settings {
  static value = 0;
}
main();
`,
  };
}

function inheritedMethod(value: number): PracticeDefinition['program'] {
  return {
    java: `
public class Main {
  public static void main(String[] args) {
    Child b = new Child(); // caller
    int x = b.getValue(); // step // caller
    Turtle t = new Turtle(x, 0); // step
  }
}
class Parent {
  int getValue() {
    return ${value};
  }
}
class Child extends Parent { }
`,
    instrumented: `
function main() {
  const b = call(Child)(); registerDisplayRef('b', () => b);
  s.set('x', call(b.getValue.bind(b))());
  const t = new Turtle(s.get('x'), 0); registerDisplayRef('t', () => t); // step
}
class Parent {
  getValue() {
    return ${value};
  }
}
class Child extends Parent { }
main();
`,
  };
}

function overrideMethod(value: number): PracticeDefinition['program'] {
  return {
    java: `
public class Main {
  public static void main(String[] args) {
    Child b = new Child(); // caller
    int x = b.getValue(); // step // caller
    Turtle t = new Turtle(x, 0); // step
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
`,
    instrumented: `
function main() {
  const b = call(Child)(); registerDisplayRef('b', () => b);
  s.set('x', call(b.getValue.bind(b))());
  const t = new Turtle(s.get('x'), 0); registerDisplayRef('t', () => t); // step
}
class Parent {
  getValue() {
    return 0;
  }
}
class Child extends Parent {
  getValue() {
    return ${value};
  }
}
main();
`,
  };
}

function baseReference(value: number): PracticeDefinition['program'] {
  return {
    java: `
public class Main {
  public static void main(String[] args) {
    Parent b = new Child(); // caller
    int x = b.getValue(); // step // caller
    Turtle t = new Turtle(x, 0); // step
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
`,
    instrumented: `
function main() {
  const b = call(Child)(); registerDisplayRef('b', () => b);
  s.set('x', call(b.getValue.bind(b))());
  const t = new Turtle(s.get('x'), 0); registerDisplayRef('t', () => t); // step
}
class Parent {
  getValue() {
    return 0;
  }
}
class Child extends Parent {
  getValue() {
    return ${value};
  }
}
main();
`,
  };
}

function packageValue(value: number): PracticeDefinition['program'] {
  return {
    java: `
// Main.java
import coordinates.Coordinate;
public class Main {
  public static void main(String[] args) {
    int x = Coordinate.getValue(); // step // caller
    Turtle t = new Turtle(x, 0); // step
  }
}
// coordinates/Coordinate.java
package coordinates;
public class Coordinate {
  public static int getValue() {
    return ${value};
  }
}
`,
    instrumented: `
function main() {
  s.set('x', call(Coordinate.getValue)());
  const t = new Turtle(s.get('x'), 0); registerDisplayRef('t', () => t); // step
}
class Coordinate {
  static getValue() {
    return ${value};
  }
}
main();
`,
  };
}

function overloadCall(value: number): PracticeDefinition['program'] {
  return {
    java: `
public class Main {
  public static void main(String[] args) {
    Parent b = new Parent(); // caller
    int x = b.getValue(${value}); // step // caller
    Turtle t = new Turtle(x, 0); // step
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
`,
    instrumented: `
function main() {
  const b = call(Parent)(); registerDisplayRef('b', () => b);
  s.set('x', call(b.getValueInt.bind(b), 'value')(${value}));
  const t = new Turtle(s.get('x'), 0); registerDisplayRef('t', () => t); // step
}
class Parent {
  getValue() {
    return 0;
  }
  getValueInt(value) {
    return value;
  }
}
main();
`,
  };
}

function overloadDispatch(value: number): PracticeDefinition['program'] {
  return {
    java: `
public class Main {
  public static void main(String[] args) {
    Parent b = new Child(); // caller
    int x = b.getValue(${value}); // step // caller
    Turtle t = new Turtle(x, 0); // step
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
`,
    instrumented: `
function main() {
  const b = call(Child)(); registerDisplayRef('b', () => b);
  s.set('x', call(b.getValueInt.bind(b), 'value')(${value}));
  const t = new Turtle(s.get('x'), 0); registerDisplayRef('t', () => t); // step
}
class Parent {
  getValue() {
    return 0;
  }
  getValueInt(value) {
    return value;
  }
}
class Child extends Parent {
  getValueInt(value) {
    return value + 1;
  }
}
main();
`,
  };
}

function trySuccess(value: number): PracticeDefinition['program'] {
  return {
    java: `
public class Main {
  public static void main(String[] args) {
    Turtle t = new Turtle(${value}, 1); // step
    try {
      t.前に進む(); // step
    } catch (RuntimeException e) {
      t.右を向く(); // step
    }
  }
}

`,
    instrumented: `
function main() {
  const t = new Turtle(${value}, 1); registerDisplayRef('t', () => t); // step
  try {
    t.前に進む(); // step
  } catch (e) {
    t.右を向く(); // step
  }
}

main();
`,
  };
}

function exceptionSkip(value: number): PracticeDefinition['program'] {
  return {
    java: `
public class Main {
  public static void main(String[] args) {
    Turtle t = new Turtle(${value}, 1); // step
    try {
      Stop.fail(); // caller
      t.前に進む(); // step
    } catch (IllegalArgumentException e) {
      t.右を向く(); // step
    }
  }
}
class Stop {
  static void fail() {
    throw new IllegalArgumentException();
  }
}
`,
    instrumented: `
function main() {
  const t = new Turtle(${value}, 1); registerDisplayRef('t', () => t); // step
  try {
    call(Stop.fail)();
    t.前に進む(); // step
  } catch (e) {
    t.右を向く(); // step
  }
}
class Stop {
  static fail() {
    throw new Error();
  }
}
main();
`,
  };
}

function customException(value: number): PracticeDefinition['program'] {
  return {
    java: `
public class Main {
  public static void main(String[] args) {
    Turtle t = new Turtle(${value}, 1); // step
    try {
      throw new Stop();
    } catch (Stop e) {
      t.後に戻る(); // step
    }
  }
}
class Stop extends Exception { }
`,
    instrumented: `
function main() {
  const t = new Turtle(${value}, 1); registerDisplayRef('t', () => t); // step
  try {
    throw new Stop();
  } catch (e) {
    t.後に戻る(); // step
  }
}
class Stop extends Error { }
main();
`,
  };
}

function cellRead(value: number): PracticeDefinition['program'] {
  return {
    java: `
public class Main {
  public static void main(String[] args) {
    int[][] values = {{0, ${value}}, {0, 0}}; // step
    int x = values[0][1]; // step
    Turtle t = new Turtle(x, 0); // step
  }
}

`,
    instrumented: `
function main() {
  const values = [[0, ${value}], [0, 0]]; registerDisplayRef('values', () => values); // step
  s.set('x', values[0][1]);
  const t = new Turtle(s.get('x'), 0); registerDisplayRef('t', () => t); // step
}

main();
`,
  };
}

function cellUpdate(value: number): PracticeDefinition['program'] {
  return {
    java: `
public class Main {
  public static void main(String[] args) {
    int[][] values = {{0, 0}, {0, 0}}; // step
    values[0][1] = ${value}; // step
    int x = values[0][1]; // step
    Turtle t = new Turtle(x, 0); // step
  }
}

`,
    instrumented: `
function main() {
  const values = [[0, 0], [0, 0]]; registerDisplayRef('values', () => values); // step
  values[0][1] = ${value}; // step
  s.set('x', values[0][1]);
  const t = new Turtle(s.get('x'), 0); registerDisplayRef('t', () => t); // step
}

main();
`,
  };
}

function layerRead(value: number): PracticeDefinition['program'] {
  return {
    java: `
public class Main {
  public static void main(String[] args) {
    int[][][] values = {{{0}}, {{${value}}}}; // step
    int x = values[1][0][0]; // step
    Turtle t = new Turtle(x, 0); // step
  }
}

`,
    instrumented: `
function main() {
  const values = [[[0]], [[${value}]]]; registerDisplayRef('values', () => values); // step
  s.set('x', values[1][0][0]);
  const t = new Turtle(s.get('x'), 0); registerDisplayRef('t', () => t); // step
}

main();
`,
  };
}
