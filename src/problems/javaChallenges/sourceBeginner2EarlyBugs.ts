import { sourceBeginner2EarlyModels } from './sourceBeginner2EarlyModels';
import { replaceSourceOnce } from './sourceModels';
import type { JavaChallengeDefinition } from './types';

export const sourceBeginner2EarlyBugs = {
  sourceMultiObject1BugWrongReceiver: {
    ...sourceBeginner2EarlyModels.multiObject1,
    title: '複数のオブジェクトを使おう(1)：操作対象の取り違え',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.multiObject1.correctProgram,
      't1.前に進む();',
      't2.前に進む();'
    ),
  },
  sourceMultiObject1BugReferenceType: {
    ...sourceBeginner2EarlyModels.multiObject1,
    title: '複数のオブジェクトを使おう(1)：オブジェクトを保持する型',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.multiObject1.correctProgram,
      'Turtle t2 = new Turtle(3, 3);',
      'int t2 = new Turtle(3, 3);'
    ),
  },
  sourceMultiObject2BugWrongReceiver: {
    ...sourceBeginner2EarlyModels.multiObject2,
    title: '複数のオブジェクトを使おう(2)：宣言前のオブジェクト参照',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.multiObject2.correctProgram,
      't1.前に進む();',
      't2.前に進む();'
    ),
  },
  sourceMultiObject2BugWrongTurn: {
    ...sourceBeginner2EarlyModels.multiObject2,
    title: '複数のオブジェクトを使おう(2)：２匹目の方向転換',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.multiObject2.correctProgram,
      't2.左を向く();',
      't2.右を向く();'
    ),
  },
  sourceMultiObject3BugWrongReceiver: {
    ...sourceBeginner2EarlyModels.multiObject3,
    title: '複数のオブジェクトを使おう(3)：前進させる亀の取り違え',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.multiObject3.correctProgram,
      't1.前に進む();',
      't2.前に進む();'
    ),
  },
  sourceMultiObject3BugReferenceType: {
    ...sourceBeginner2EarlyModels.multiObject3,
    title: '複数のオブジェクトを使おう(3)：３匹目の参照型',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.multiObject3.correctProgram,
      'Turtle t3 = new Turtle(2, 1);',
      'int t3 = new Turtle(2, 1);'
    ),
  },
  sourceMultiObject4BugWrongReceiver: {
    ...sourceBeginner2EarlyModels.multiObject4,
    title: '複数のオブジェクトを使おう(4)：繰り返し内の操作対象',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.multiObject4.correctProgram,
      't2.前に進む();',
      't1.前に進む();'
    ),
  },
  sourceMultiObject4BugConditionType: {
    ...sourceBeginner2EarlyModels.multiObject4,
    title: '複数のオブジェクトを使おう(4)：方向転換を決める条件式',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.multiObject4.correctProgram,
      'if (i % 2 == 0)',
      'if (i % 2)'
    ),
  },
  sourceMultiObject5BugMissingInitialTurn: {
    ...sourceBeginner2EarlyModels.multiObject5,
    title: '複数のオブジェクトを使おう(5)：走査開始時の方向転換',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.multiObject5.correctProgram,
      '    t1.右を向く();\n\n    while',
      '    while'
    ),
  },
  sourceMultiObject5BugPredicateResult: {
    ...sourceBeginner2EarlyModels.multiObject5,
    title: '複数のオブジェクトを使おう(5)：移動可能性を問い合わせるメソッド',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.multiObject5.correctProgram,
      'while (t1.前に進めるか()) {\n      while',
      'while (t1.前に進む()) {\n      while'
    ),
  },
  sourceMultiObject6BugWrongStepArgument: {
    ...sourceBeginner2EarlyModels.multiObject6,
    title: '複数のオブジェクトを使おう(6)：亀ごとの歩数引数',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.multiObject6.correctProgram,
      'N歩前に進める(turtles[j], j);',
      'N歩前に進める(turtles[j], i);'
    ),
  },
  sourceMultiObject6BugArrayInsteadOfElement: {
    ...sourceBeginner2EarlyModels.multiObject6,
    title: '複数のオブジェクトを使おう(6)：配列と要素の区別',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.multiObject6.correctProgram,
      'N歩前に進める(turtles[j], j);',
      'N歩前に進める(turtles, j);'
    ),
  },
  sourceMakeClass1BugSpeedOverwrite: {
    ...sourceBeginner2EarlyModels.makeClass1,
    title: 'クラスを作ろう(1)：フィールドの代入と加算',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.makeClass1.correctProgram,
      't.speed = 1;',
      't.speed += 1;'
    ),
  },
  sourceMakeClass1BugFieldCondition: {
    ...sourceBeginner2EarlyModels.makeClass1,
    title: 'クラスを作ろう(1)：フィールドを使う繰り返し条件',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.makeClass1.correctProgram,
      'i < this.speed',
      'this.speed'
    ),
  },
  sourceMakeClass2BugSpeedOverwrite: {
    ...sourceBeginner2EarlyModels.makeClass2,
    title: 'クラスを作ろう(2)：速度フィールドの更新',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.makeClass2.correctProgram,
      't.speed = 2;',
      't.speed = t.speed;'
    ),
  },
  sourceMakeClass2BugFieldCondition: {
    ...sourceBeginner2EarlyModels.makeClass2,
    title: 'クラスを作ろう(2)：斜め移動の繰り返し条件',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.makeClass2.correctProgram,
      'i < this.speed',
      'this.speed'
    ),
  },
  sourceMakeClass3BugIgnoredSizeUpdate: {
    ...sourceBeginner2EarlyModels.makeClass3,
    title: 'クラスを作ろう(3)：次の正方形のサイズ更新',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.makeClass3.correctProgram,
      't.size = 4;',
      't.size = t.size;'
    ),
  },
  sourceMakeClass3BugFieldCondition: {
    ...sourceBeginner2EarlyModels.makeClass3,
    title: 'クラスを作ろう(3)：図形描画の繰り返し条件',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.makeClass3.correctProgram,
      'i < this.size * 4',
      'this.size * 4'
    ),
  },
  sourceMakeClass4BugOwnedFieldType: {
    ...sourceBeginner2EarlyModels.makeClass4,
    title: 'クラスを作ろう(4)：保持する亀のフィールド型',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.makeClass4.correctProgram,
      'Turtle slow = new Turtle(5, 1);',
      'int slow = new Turtle(5, 1);'
    ),
  },
  sourceMakeClass4BugFieldCondition: {
    ...sourceBeginner2EarlyModels.makeClass4,
    title: 'クラスを作ろう(4)：速度フィールドの条件式',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.makeClass4.correctProgram,
      'i < this.speed',
      'this.speed'
    ),
  },
  sourceMakeClass5BugIgnoredOperationUpdate: {
    ...sourceBeginner2EarlyModels.makeClass5,
    title: 'クラスを作ろう(5)：次回の操作列の更新',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.makeClass5.correctProgram,
      't.operation = "LFFRFF";',
      't.operation = t.operation;'
    ),
  },
  sourceMakeClass5BugSelectorType: {
    ...sourceBeginner2EarlyModels.makeClass5,
    title: 'クラスを作ろう(5)：switchの選択値の型',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.makeClass5.correctProgram,
      'switch (this.operation.charAt(i))',
      "switch (this.operation.charAt(i) == 'F')"
    ),
  },
  sourceMakeClass6BugSpeedUpdateDirection: {
    ...sourceBeginner2EarlyModels.makeClass6,
    title: 'クラスを作ろう(6)：移動後の速度更新',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(sourceBeginner2EarlyModels.makeClass6.correctProgram, 'speed++;', 'speed--;'),
  },
  sourceMakeClass6BugFieldCondition: {
    ...sourceBeginner2EarlyModels.makeClass6,
    title: 'クラスを作ろう(6)：現在速度を使う条件式',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.makeClass6.correctProgram,
      'i < this.speed',
      'this.speed'
    ),
  },
  sourceConstructor1BugShadowedAssignment: {
    ...sourceBeginner2EarlyModels.constructor1,
    title: 'コンストラクタ(1)：引数と初期化先フィールド',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.constructor1.correctProgram,
      'this.speed = speed;',
      'speed = speed;'
    ),
  },
  sourceConstructor1BugConstructorReturnType: {
    ...sourceBeginner2EarlyModels.constructor1,
    title: 'コンストラクタ(1)：コンストラクターの宣言',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.constructor1.correctProgram,
      'MyTurtle(int x, int y, int speed)',
      'void MyTurtle(int x, int y, int speed)'
    ),
  },
  sourceConstructor2BugOperationParameterType: {
    ...sourceBeginner2EarlyModels.constructor2,
    title: 'コンストラクタ(2)：操作列を受け取る引数の型',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.constructor2.correctProgram,
      'int y, String operation',
      'int y, int operation'
    ),
  },
  sourceConstructor2BugConstructorReturnType: {
    ...sourceBeginner2EarlyModels.constructor2,
    title: 'コンストラクタ(2)：コンストラクターの宣言',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.constructor2.correctProgram,
      'MyTurtle(int x, int y, String operation)',
      'void MyTurtle(int x, int y, String operation)'
    ),
  },
  sourceConstructor3BugShadowedAssignment: {
    ...sourceBeginner2EarlyModels.constructor3,
    title: 'コンストラクタ(3)：初期速度の保存先',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.constructor3.correctProgram,
      'this.speed = speed;',
      'speed = speed;'
    ),
  },
  sourceConstructor3BugConstructorReturnType: {
    ...sourceBeginner2EarlyModels.constructor3,
    title: 'コンストラクタ(3)：コンストラクターの宣言',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.constructor3.correctProgram,
      'MyTurtle(int speed)',
      'void MyTurtle(int speed)'
    ),
  },
  sourceEncapsulationBugShadowedSetter: {
    ...sourceBeginner2EarlyModels.encapsulation,
    title: 'カプセル化：設定メソッドの代入先',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.encapsulation.correctProgram,
      'this.speed = speed;',
      'speed = speed;'
    ),
  },
  sourceEncapsulationBugPrivateAccess: {
    ...sourceBeginner2EarlyModels.encapsulation,
    title: 'カプセル化：非公開フィールドのアクセス',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.encapsulation.correctProgram,
      't.changeSpeed(1);',
      't.speed = 1;'
    ),
  },
  sourceWithoutEncapsulationBugInclusiveSideBound: {
    ...sourceBeginner2EarlyModels.withoutEncapsulation,
    title: 'カプセル化なし(1)：辺の移動回数の境界',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.withoutEncapsulation.correctProgram,
      'j < size - 1',
      'j <= size - 1'
    ),
  },
  sourceWithoutEncapsulationBugWrongParameterType: {
    ...sourceBeginner2EarlyModels.withoutEncapsulation,
    title: 'カプセル化なし(1)：描画対象を受け取る型',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.withoutEncapsulation.correctProgram,
      'static void drawSquare(Turtle t, int size)',
      'static void drawSquare(int t, int size)'
    ),
  },
  sourceWithEncapsulationBugInclusiveSideBound: {
    ...sourceBeginner2EarlyModels.withEncapsulation,
    title: 'カプセル化あり(1)：辺の移動回数の境界',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.withEncapsulation.correctProgram,
      'j < size - 1',
      'j <= size - 1'
    ),
  },
  sourceWithEncapsulationBugPrivateAccess: {
    ...sourceBeginner2EarlyModels.withEncapsulation,
    title: 'カプセル化あり(1)：内部の亀への直接アクセス',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.withEncapsulation.correctProgram,
      't.draw(3);',
      't.t.前に進む();'
    ),
  },
  sourceWithoutEncapsulation2BugMissingDelegation: {
    ...sourceBeginner2EarlyModels.withoutEncapsulation2,
    title: 'カプセル化なし(2)：曲線の最初の線を描く呼び出し',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.withoutEncapsulation2.correctProgram,
      'drawLine(t, speed);\n    t.右を向く();',
      't.右を向く();'
    ),
  },
  sourceWithoutEncapsulation2BugMissingReceiverArgument: {
    ...sourceBeginner2EarlyModels.withoutEncapsulation2,
    title: 'カプセル化なし(2)：描画対象を渡す引数',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.withoutEncapsulation2.correctProgram,
      'drawLine(t, speed);\n    t.右を向く();',
      'drawLine(speed);\n    t.右を向く();'
    ),
  },
  sourceWithEncapsulation2BugMissingDelegation: {
    ...sourceBeginner2EarlyModels.withEncapsulation2,
    title: 'カプセル化あり(2)：曲線の最初の線を描く呼び出し',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.withEncapsulation2.correctProgram,
      'this.drawLine(speed);\n    this.t.右を向く();',
      'this.t.右を向く();'
    ),
  },
  sourceWithEncapsulation2BugPrivateAccess: {
    ...sourceBeginner2EarlyModels.withEncapsulation2,
    title: 'カプセル化あり(2)：カプセル化したフィールドの参照',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.withEncapsulation2.correctProgram,
      't.draw(2);',
      't.t.前に進む();'
    ),
  },
  sourceWithEncapsulation4BugIgnoredUpperClamp: {
    ...sourceBeginner2EarlyModels.withEncapsulation4,
    title: 'カプセル化あり(4)：上限を超えた速度の補正',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.withEncapsulation4.correctProgram,
      'else if (5 < speed) this.speed = 5;',
      'else if (5 < speed) this.speed = this.speed;'
    ),
  },
  sourceWithEncapsulation4BugPrivateAccess: {
    ...sourceBeginner2EarlyModels.withEncapsulation4,
    title: 'カプセル化あり(4)：設定メソッドを介した変更',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.withEncapsulation4.correctProgram,
      't.setSpeed(-1);',
      't.speed = -1;'
    ),
  },
  sourceWithEncapsulation5BugWrongSignChange: {
    ...sourceBeginner2EarlyModels.withEncapsulation5,
    title: 'カプセル化あり(5)：速度変更時の方向反転条件',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.withEncapsulation5.correctProgram,
      'this.speed * speed < 0',
      'this.speed < 0'
    ),
  },
  sourceWithEncapsulation5BugConditionType: {
    ...sourceBeginner2EarlyModels.withEncapsulation5,
    title: 'カプセル化あり(5)：方向反転の条件式',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.withEncapsulation5.correctProgram,
      'if (this.speed * speed < 0)',
      'if (this.speed * speed)'
    ),
  },
  sourceWithEncapsulation7BugIgnoredSetter: {
    ...sourceBeginner2EarlyModels.withEncapsulation7,
    title: 'カプセル化あり(7)：設定した操作列の保存',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.withEncapsulation7.correctProgram,
      'this.operation = op;',
      'this.operation = this.operation;'
    ),
  },
  sourceWithEncapsulation7BugPrivateAccess: {
    ...sourceBeginner2EarlyModels.withEncapsulation7,
    title: 'カプセル化あり(7)：非公開の操作列の更新',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.withEncapsulation7.correctProgram,
      't.setOperation("ABC");',
      't.operation = "ABC";'
    ),
  },
  sourceStaticMethod1BugWrongReceiver: {
    ...sourceBeginner2EarlyModels.staticMethod1,
    title: '静的メソッド(1)：静的メソッドに渡す亀',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.staticMethod1.correctProgram,
      'Controller.moveTwoSteps(t2);',
      'Controller.moveTwoSteps(t1);'
    ),
  },
  sourceStaticMethod1BugInstanceMethod: {
    ...sourceBeginner2EarlyModels.staticMethod1,
    title: '静的メソッド(1)：クラスから呼ぶメソッドの宣言',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.staticMethod1.correctProgram,
      'static void moveTwoSteps',
      'void moveTwoSteps'
    ),
  },
  sourceStaticMethod2BugWrongReceiver: {
    ...sourceBeginner2EarlyModels.staticMethod2,
    title: '静的メソッド(2)：静的メソッドの操作対象',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.staticMethod2.correctProgram,
      'Controller.moveTwoSteps(t2);',
      'Controller.moveTwoSteps(t1);'
    ),
  },
  sourceStaticMethod2BugInstanceMethod: {
    ...sourceBeginner2EarlyModels.staticMethod2,
    title: '静的メソッド(2)：静的呼び出しと宣言',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.staticMethod2.correctProgram,
      'static void moveTwoSteps',
      'void moveTwoSteps'
    ),
  },
  sourceStaticMethod3BugWrongReceiver: {
    ...sourceBeginner2EarlyModels.staticMethod3,
    title: '静的メソッド(3)：３匹目へ渡す参照',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.staticMethod3.correctProgram,
      'Controller.moveThreeSteps(t3);',
      'Controller.moveThreeSteps(t2);'
    ),
  },
  sourceStaticMethod3BugInstanceMethod: {
    ...sourceBeginner2EarlyModels.staticMethod3,
    title: '静的メソッド(3)：静的メソッドの宣言',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.staticMethod3.correctProgram,
      'static void moveThreeSteps',
      'void moveThreeSteps'
    ),
  },
  sourceStaticMethod4BugWrongDelegatedLength: {
    ...sourceBeginner2EarlyModels.staticMethod4,
    title: '静的メソッド(4)：補助メソッドに渡す辺の長さ',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.staticMethod4.correctProgram,
      'Controller.drawLine(t, size - 1);',
      'Controller.drawLine(t, size);'
    ),
  },
  sourceStaticMethod4BugInstanceHelper: {
    ...sourceBeginner2EarlyModels.staticMethod4,
    title: '静的メソッド(4)：静的補助メソッドの宣言',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.staticMethod4.correctProgram,
      'static void drawLine',
      'void drawLine'
    ),
  },
  sourceStaticField1BugWrongReceiver: {
    ...sourceBeginner2EarlyModels.staticField1,
    title: '静的フィールド(1)：共有メソッドに渡す操作対象',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.staticField1.correctProgram,
      'Controller.moveTwoSteps(t2);',
      'Controller.moveTwoSteps(t1);'
    ),
  },
  sourceStaticField1BugInstanceCounter: {
    ...sourceBeginner2EarlyModels.staticField1,
    title: '静的フィールド(1)：クラス共通のカウンター宣言',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.staticField1.correctProgram,
      'static int stepCount;',
      'int stepCount;'
    ),
  },
  sourceStaticField2BugSubtractInsteadOfAssign: {
    ...sourceBeginner2EarlyModels.staticField2,
    title: '静的フィールド(2)：共有速度の上書き',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.staticField2.correctProgram,
      'Settings.speed = 2;',
      'Settings.speed -= 2;'
    ),
  },
  sourceStaticField2BugInstanceSetting: {
    ...sourceBeginner2EarlyModels.staticField2,
    title: '静的フィールド(2)：共有設定の静的宣言',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.staticField2.correctProgram,
      'static public int speed',
      'public int speed'
    ),
  },
  sourceStaticField3BugWrongSettingUpdate: {
    ...sourceBeginner2EarlyModels.staticField3,
    title: '静的フィールド(3)：共有速度の更新先',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.staticField3.correctProgram,
      'Settings.speed = 3;',
      'Settings.speed = Settings.speed;'
    ),
  },
  sourceStaticField3BugInstanceSetting: {
    ...sourceBeginner2EarlyModels.staticField3,
    title: '静的フィールド(3)：他クラスから参照する共有設定',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.staticField3.correctProgram,
      'static public int speed',
      'public int speed'
    ),
  },
  sourceStaticField4BugMissingSharedAcceleration: {
    ...sourceBeginner2EarlyModels.staticField4,
    title: '静的フィールド(4)：次の亀へ伝わる速度更新',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.staticField4.correctProgram,
      'Settings.speed++;',
      'Settings.speed = Settings.speed;'
    ),
  },
  sourceStaticField4BugInstanceSetting: {
    ...sourceBeginner2EarlyModels.staticField4,
    title: '静的フィールド(4)：クラス間で共有する速度',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.staticField4.correctProgram,
      'static public int speed',
      'public int speed'
    ),
  },
  sourceStaticField5BugMissingSharedUpdate: {
    ...sourceBeginner2EarlyModels.staticField5,
    title: '静的フィールド(5)：追加速度を共有する更新',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.staticField5.correctProgram,
      'Settings.additionalSpeed++;',
      'Settings.additionalSpeed = Settings.additionalSpeed;'
    ),
  },
  sourceStaticField5BugInstanceSetting: {
    ...sourceBeginner2EarlyModels.staticField5,
    title: '静的フィールド(5)：追加速度の静的宣言',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.staticField5.correctProgram,
      'static public int additionalSpeed',
      'public int additionalSpeed'
    ),
  },
  sourceStaticField6BugSharedInsteadOfInstanceUpdate: {
    ...sourceBeginner2EarlyModels.staticField6,
    title: '静的フィールド(6)：個別速度と共有速度の更新先',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.staticField6.correctProgram,
      't1.base++;',
      'Settings.additionalSpeed++;'
    ),
  },
  sourceStaticField6BugInstanceSetting: {
    ...sourceBeginner2EarlyModels.staticField6,
    title: '静的フィールド(6)：共有追加速度の宣言',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.staticField6.correctProgram,
      'static public int additionalSpeed',
      'public int additionalSpeed'
    ),
  },
} satisfies Record<string, JavaChallengeDefinition>;
