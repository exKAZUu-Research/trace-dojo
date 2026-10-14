import { sourceBeginner2EarlyModels } from './sourceBeginner2EarlyModels';
import { replaceSourceOnce } from './sourceModels';
import type { JavaChallengeDefinition } from './types';

export const sourceBeginner2EarlyBlanks = {
  sourceMultiObject1BlankFirstReceiver: {
    ...sourceBeginner2EarlyModels.multiObject1,
    title: '複数のオブジェクトを使おう(1)：１匹目の操作対象',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.multiObject1.correctProgram,
      't1.前に進む();',
      '@[t1]@.前に進む();'
    ),
  },
  sourceMultiObject1BlankSecondTurn: {
    ...sourceBeginner2EarlyModels.multiObject1,
    title: '複数のオブジェクトを使おう(1)：２匹目の向き',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.multiObject1.correctProgram,
      't2.左を向く();',
      't2.@[左を向く]@();'
    ),
  },
  sourceMultiObject2BlankFirstTurn: {
    ...sourceBeginner2EarlyModels.multiObject2,
    title: '複数のオブジェクトを使おう(2)：１匹目の向き',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.multiObject2.correctProgram,
      't1.右を向く();',
      't1.@[右を向く]@();'
    ),
  },
  sourceMultiObject2BlankSecondReceiver: {
    ...sourceBeginner2EarlyModels.multiObject2,
    title: '複数のオブジェクトを使おう(2)：２匹目の操作対象',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.multiObject2.correctProgram,
      't2.左を向く();',
      '@[t2]@.左を向く();'
    ),
  },
  sourceMultiObject3BlankFirstAdvance: {
    ...sourceBeginner2EarlyModels.multiObject3,
    title: '複数のオブジェクトを使おう(3)：１匹目の前進対象',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.multiObject3.correctProgram,
      't1.前に進む();',
      '@[t1]@.前に進む();'
    ),
  },
  sourceMultiObject3BlankThirdTurn: {
    ...sourceBeginner2EarlyModels.multiObject3,
    title: '複数のオブジェクトを使おう(3)：３匹目の方向転換',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.multiObject3.correctProgram,
      't3.右を向く();',
      '@[t3]@.右を向く();'
    ),
  },
  sourceMultiObject4BlankSecondAdvance: {
    ...sourceBeginner2EarlyModels.multiObject4,
    title: '複数のオブジェクトを使おう(4)：２匹目の前進対象',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.multiObject4.correctProgram,
      't2.前に進む();',
      '@[t2]@.前に進む();'
    ),
  },
  sourceMultiObject4BlankAlternatingTurns: {
    ...sourceBeginner2EarlyModels.multiObject4,
    title: '複数のオブジェクトを使おう(4)：２匹の方向転換条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.multiObject4.correctProgram,
      'if (i % 2 == 0)',
      'if (@[i % 2 == 0]@)'
    ),
  },
  sourceMultiObject5BlankObstacleCheck: {
    ...sourceBeginner2EarlyModels.multiObject5,
    title: '複数のオブジェクトを使おう(5)：進行可能性の確認',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.multiObject5.correctProgram,
      'while (t1.前に進めるか()) {\n      while',
      'while (@[t1.前に進めるか()]@) {\n      while'
    ),
  },
  sourceMultiObject5BlankMovingReceiver: {
    ...sourceBeginner2EarlyModels.multiObject5,
    title: '複数のオブジェクトを使おう(5)：障害物の間を進む亀',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.multiObject5.correctProgram,
      't1.前に進む();',
      '@[t1]@.前に進む();'
    ),
  },
  sourceMultiObject6BlankSelectedObject: {
    ...sourceBeginner2EarlyModels.multiObject6,
    title: '複数のオブジェクトを使おう(6)：配列から選ぶ亀',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.multiObject6.correctProgram,
      'N歩前に進める(turtles[j], j);',
      'N歩前に進める(@[turtles[j]]@, j);'
    ),
  },
  sourceMultiObject6BlankStepArgument: {
    ...sourceBeginner2EarlyModels.multiObject6,
    title: '複数のオブジェクトを使おう(6)：亀ごとの歩数',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.multiObject6.correctProgram,
      'N歩前に進める(turtles[j], j);',
      'N歩前に進める(turtles[j], @[j]@);'
    ),
  },
  sourceMakeClass1BlankSpeedField: {
    ...sourceBeginner2EarlyModels.makeClass1,
    title: 'クラスを作ろう(1)：インスタンスの速度',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.makeClass1.correctProgram,
      'i < this.speed',
      'i < @[this.speed]@'
    ),
  },
  sourceMakeClass1BlankOwnedTurtle: {
    ...sourceBeginner2EarlyModels.makeClass1,
    title: 'クラスを作ろう(1)：保持する亀の操作',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.makeClass1.correctProgram,
      'this.t.前に進む();',
      '@[this.t]@.前に進む();'
    ),
  },
  sourceMakeClass2BlankSpeedField: {
    ...sourceBeginner2EarlyModels.makeClass2,
    title: 'クラスを作ろう(2)：斜め移動の反復数',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.makeClass2.correctProgram,
      'i < this.speed',
      'i < @[this.speed]@'
    ),
  },
  sourceMakeClass2BlankRestoreDirection: {
    ...sourceBeginner2EarlyModels.makeClass2,
    title: 'クラスを作ろう(2)：斜め移動後の向き',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.makeClass2.correctProgram,
      'this.t.左を向く();',
      'this.t.@[左を向く]@();'
    ),
  },
  sourceMakeClass3BlankSquareBoundary: {
    ...sourceBeginner2EarlyModels.makeClass3,
    title: 'クラスを作ろう(3)：角で曲がる条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.makeClass3.correctProgram,
      'i % this.size == this.size - 1',
      '@[i % this.size == this.size - 1]@'
    ),
  },
  sourceMakeClass3BlankSideCount: {
    ...sourceBeginner2EarlyModels.makeClass3,
    title: 'クラスを作ろう(3)：四辺の反復範囲',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.makeClass3.correctProgram,
      'i < this.size * 4',
      'i < @[this.size * 4]@'
    ),
  },
  sourceMakeClass4BlankSlowReceiver: {
    ...sourceBeginner2EarlyModels.makeClass4,
    title: 'クラスを作ろう(4)：低速の亀',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.makeClass4.correctProgram,
      'this.slow.前に進む();',
      '@[this.slow]@.前に進む();'
    ),
  },
  sourceMakeClass4BlankSpeedField: {
    ...sourceBeginner2EarlyModels.makeClass4,
    title: 'クラスを作ろう(4)：共有する移動回数',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.makeClass4.correctProgram,
      'i < this.speed',
      'i < @[this.speed]@'
    ),
  },
  sourceMakeClass5BlankCommandSelection: {
    ...sourceBeginner2EarlyModels.makeClass5,
    title: 'クラスを作ろう(5)：操作文字の取り出し',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.makeClass5.correctProgram,
      'this.operation.charAt(i)',
      '@[this.operation.charAt(i)]@'
    ),
  },
  sourceMakeClass5BlankOperationLength: {
    ...sourceBeginner2EarlyModels.makeClass5,
    title: 'クラスを作ろう(5)：操作列の長さ',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.makeClass5.correctProgram,
      'i < this.operation.length()',
      'i < @[this.operation.length()]@'
    ),
  },
  sourceMakeClass6BlankAcceleration: {
    ...sourceBeginner2EarlyModels.makeClass6,
    title: 'クラスを作ろう(6)：次回の速度更新',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceBeginner2EarlyModels.makeClass6.correctProgram, 'speed++;', '@[speed++]@;'),
  },
  sourceMakeClass6BlankSpeedField: {
    ...sourceBeginner2EarlyModels.makeClass6,
    title: 'クラスを作ろう(6)：現在の速度参照',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.makeClass6.correctProgram,
      'i < this.speed',
      'i < @[this.speed]@'
    ),
  },
  sourceConstructor1BlankSpeedInitialization: {
    ...sourceBeginner2EarlyModels.constructor1,
    title: 'コンストラクタ(1)：引数とフィールドの区別',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.constructor1.correctProgram,
      'this.speed = speed;',
      '@[this.speed]@ = speed;'
    ),
  },
  sourceConstructor1BlankTurtleInitialization: {
    ...sourceBeginner2EarlyModels.constructor1,
    title: 'コンストラクタ(1)：座標を渡す初期化',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.constructor1.correctProgram,
      'this.t = new Turtle(x, y);',
      'this.t = @[new Turtle(x, y)]@;'
    ),
  },
  sourceConstructor2BlankOperationInitialization: {
    ...sourceBeginner2EarlyModels.constructor2,
    title: 'コンストラクタ(2)：操作列の保存先',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.constructor2.correctProgram,
      'this.operation = operation;',
      '@[this.operation]@ = operation;'
    ),
  },
  sourceConstructor2BlankConstructorCoordinates: {
    ...sourceBeginner2EarlyModels.constructor2,
    title: 'コンストラクタ(2)：引数で亀を配置',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.constructor2.correctProgram,
      'this.t = new Turtle(x, y);',
      'this.t = new Turtle(@[x, y]@);'
    ),
  },
  sourceConstructor3BlankSpeedInitialization: {
    ...sourceBeginner2EarlyModels.constructor3,
    title: 'コンストラクタ(3)：速度の初期化先',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.constructor3.correctProgram,
      'this.speed = speed;',
      '@[this.speed]@ = speed;'
    ),
  },
  sourceConstructor3BlankDeceleration: {
    ...sourceBeginner2EarlyModels.constructor3,
    title: 'コンストラクタ(3)：移動後の速度更新',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.constructor3.correctProgram,
      'this.speed--;',
      '@[this.speed--]@;'
    ),
  },
  sourceEncapsulationBlankSetterAssignment: {
    ...sourceBeginner2EarlyModels.encapsulation,
    title: 'カプセル化：設定メソッドの代入先',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.encapsulation.correctProgram,
      'this.speed = speed;',
      '@[this.speed]@ = speed;'
    ),
  },
  sourceEncapsulationBlankSetterCall: {
    ...sourceBeginner2EarlyModels.encapsulation,
    title: 'カプセル化：公開メソッドで速度変更',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.encapsulation.correctProgram,
      't.changeSpeed(1);',
      't.@[changeSpeed]@(1);'
    ),
  },
  sourceWithoutEncapsulationBlankTurtleArgument: {
    ...sourceBeginner2EarlyModels.withoutEncapsulation,
    title: 'カプセル化なし(1)：描画する亀を引数で渡す',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.withoutEncapsulation.correctProgram,
      'drawSquare(t, 3);',
      'drawSquare(@[t]@, 3);'
    ),
  },
  sourceWithoutEncapsulationBlankSideLength: {
    ...sourceBeginner2EarlyModels.withoutEncapsulation,
    title: 'カプセル化なし(1)：辺の移動回数',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.withoutEncapsulation.correctProgram,
      'j < size - 1',
      'j < @[size - 1]@'
    ),
  },
  sourceWithEncapsulationBlankOwnedTurtle: {
    ...sourceBeginner2EarlyModels.withEncapsulation,
    title: 'カプセル化あり(1)：クラス内部の亀',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.withEncapsulation.correctProgram,
      'this.t.前に進む();',
      '@[this.t]@.前に進む();'
    ),
  },
  sourceWithEncapsulationBlankSideLength: {
    ...sourceBeginner2EarlyModels.withEncapsulation,
    title: 'カプセル化あり(1)：描画サイズの利用',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.withEncapsulation.correctProgram,
      'j < size - 1',
      'j < @[size - 1]@'
    ),
  },
  sourceWithoutEncapsulation2BlankDelegation: {
    ...sourceBeginner2EarlyModels.withoutEncapsulation2,
    title: 'カプセル化なし(2)：補助メソッドへの引数',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.withoutEncapsulation2.correctProgram,
      'drawLine(t, speed);\n    t.右を向く();',
      'drawLine(@[t, speed]@);\n    t.右を向く();'
    ),
  },
  sourceWithoutEncapsulation2BlankLineBound: {
    ...sourceBeginner2EarlyModels.withoutEncapsulation2,
    title: 'カプセル化なし(2)：引数に応じた線の長さ',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.withoutEncapsulation2.correctProgram,
      'i < speed',
      'i < @[speed]@'
    ),
  },
  sourceWithEncapsulation2BlankDelegation: {
    ...sourceBeginner2EarlyModels.withEncapsulation2,
    title: 'カプセル化あり(2)：補助メソッドに長さを渡す',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.withEncapsulation2.correctProgram,
      'this.drawLine(speed);\n    this.t.右を向く();',
      'this.drawLine(@[speed]@);\n    this.t.右を向く();'
    ),
  },
  sourceWithEncapsulation2BlankOwnedTurtle: {
    ...sourceBeginner2EarlyModels.withEncapsulation2,
    title: 'カプセル化あり(2)：内部フィールドの操作',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.withEncapsulation2.correctProgram,
      'this.t.前に進む();',
      '@[this.t]@.前に進む();'
    ),
  },
  sourceWithEncapsulation4BlankGetter: {
    ...sourceBeginner2EarlyModels.withEncapsulation4,
    title: 'カプセル化あり(4)：速度の取得',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.withEncapsulation4.correctProgram,
      'return this.speed;',
      'return @[this.speed]@;'
    ),
  },
  sourceWithEncapsulation4BlankLowerBound: {
    ...sourceBeginner2EarlyModels.withEncapsulation4,
    title: 'カプセル化あり(4)：負の速度の検証',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.withEncapsulation4.correctProgram,
      'if (speed < 0)',
      'if (@[speed < 0]@)'
    ),
  },
  sourceWithEncapsulation5BlankMagnitude: {
    ...sourceBeginner2EarlyModels.withEncapsulation5,
    title: 'カプセル化あり(5)：速度の大きさ',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.withEncapsulation5.correctProgram,
      'Math.abs(this.speed)',
      '@[Math.abs(this.speed)]@'
    ),
  },
  sourceWithEncapsulation5BlankSignChange: {
    ...sourceBeginner2EarlyModels.withEncapsulation5,
    title: 'カプセル化あり(5)：進行方向を反転する条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.withEncapsulation5.correctProgram,
      'this.speed * speed < 0',
      '@[this.speed * speed < 0]@'
    ),
  },
  sourceWithEncapsulation7BlankSetterAssignment: {
    ...sourceBeginner2EarlyModels.withEncapsulation7,
    title: 'カプセル化あり(7)：操作列を内部に保存',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.withEncapsulation7.correctProgram,
      'this.operation = op;',
      '@[this.operation]@ = op;'
    ),
  },
  sourceWithEncapsulation7BlankCommandSelection: {
    ...sourceBeginner2EarlyModels.withEncapsulation7,
    title: 'カプセル化あり(7)：保存した操作列の読み出し',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.withEncapsulation7.correctProgram,
      'this.operation.charAt(i)',
      '@[this.operation.charAt(i)]@'
    ),
  },
  sourceStaticMethod1BlankStaticDeclaration: {
    ...sourceBeginner2EarlyModels.staticMethod1,
    title: '静的メソッド(1)：クラスから呼べるメソッド',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.staticMethod1.correctProgram,
      'static void moveTwoSteps',
      '@[static]@ void moveTwoSteps'
    ),
  },
  sourceStaticMethod1BlankReceiverArgument: {
    ...sourceBeginner2EarlyModels.staticMethod1,
    title: '静的メソッド(1)：操作対象を渡す',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.staticMethod1.correctProgram,
      'Controller.moveTwoSteps(t2);',
      'Controller.moveTwoSteps(@[t2]@);'
    ),
  },
  sourceStaticMethod2BlankStaticDeclaration: {
    ...sourceBeginner2EarlyModels.staticMethod2,
    title: '静的メソッド(2)：静的メソッドの宣言',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.staticMethod2.correctProgram,
      'static void moveTwoSteps',
      '@[static]@ void moveTwoSteps'
    ),
  },
  sourceStaticMethod2BlankReceiverArgument: {
    ...sourceBeginner2EarlyModels.staticMethod2,
    title: '静的メソッド(2)：１匹目を渡す',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.staticMethod2.correctProgram,
      'Controller.moveTwoSteps(t1);',
      'Controller.moveTwoSteps(@[t1]@);'
    ),
  },
  sourceStaticMethod3BlankStaticDeclaration: {
    ...sourceBeginner2EarlyModels.staticMethod3,
    title: '静的メソッド(3)：静的メソッドの宣言',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.staticMethod3.correctProgram,
      'static void moveThreeSteps',
      '@[static]@ void moveThreeSteps'
    ),
  },
  sourceStaticMethod3BlankReceiverArgument: {
    ...sourceBeginner2EarlyModels.staticMethod3,
    title: '静的メソッド(3)：３匹目を渡す',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.staticMethod3.correctProgram,
      'Controller.moveThreeSteps(t3);',
      'Controller.moveThreeSteps(@[t3]@);'
    ),
  },
  sourceStaticMethod4BlankDelegatedArguments: {
    ...sourceBeginner2EarlyModels.staticMethod4,
    title: '静的メソッド(4)：静的補助メソッドへの引数',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.staticMethod4.correctProgram,
      'Controller.drawLine(t, size - 1);',
      'Controller.drawLine(@[t, size - 1]@);'
    ),
  },
  sourceStaticMethod4BlankStaticDeclaration: {
    ...sourceBeginner2EarlyModels.staticMethod4,
    title: '静的メソッド(4)：正方形描画の静的宣言',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.staticMethod4.correctProgram,
      'static void drawSquare',
      '@[static]@ void drawSquare'
    ),
  },
  sourceStaticField1BlankSharedDeclaration: {
    ...sourceBeginner2EarlyModels.staticField1,
    title: '静的フィールド(1)：クラス共通のカウンター宣言',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.staticField1.correctProgram,
      'static int stepCount;',
      '@[static]@ int stepCount;'
    ),
  },
  sourceStaticField1BlankReceiverArgument: {
    ...sourceBeginner2EarlyModels.staticField1,
    title: '静的フィールド(1)：共有メソッドの操作対象',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.staticField1.correctProgram,
      'Controller.moveTwoSteps(t2);',
      'Controller.moveTwoSteps(@[t2]@);'
    ),
  },
  sourceStaticField2BlankSharedSpeed: {
    ...sourceBeginner2EarlyModels.staticField2,
    title: '静的フィールド(2)：共有速度の参照',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.staticField2.correctProgram,
      'i < Settings.speed',
      'i < @[Settings.speed]@'
    ),
  },
  sourceStaticField2BlankStaticDeclaration: {
    ...sourceBeginner2EarlyModels.staticField2,
    title: '静的フィールド(2)：共有フィールドの宣言',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.staticField2.correctProgram,
      'static public int speed',
      '@[static]@ public int speed'
    ),
  },
  sourceStaticField3BlankSquareSharedSpeed: {
    ...sourceBeginner2EarlyModels.staticField3,
    title: '静的フィールド(3)：別クラスから共有速度を参照',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.staticField3.correctProgram,
      'j < Settings.speed',
      'j < @[Settings.speed]@'
    ),
  },
  sourceStaticField3BlankStaticDeclaration: {
    ...sourceBeginner2EarlyModels.staticField3,
    title: '静的フィールド(3)：速度をクラスで共有',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.staticField3.correctProgram,
      'static public int speed',
      '@[static]@ public int speed'
    ),
  },
  sourceStaticField4BlankSharedAcceleration: {
    ...sourceBeginner2EarlyModels.staticField4,
    title: '静的フィールド(4)：他の亀にも伝わる速度更新',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.staticField4.correctProgram,
      'Settings.speed++;',
      '@[Settings.speed++]@;'
    ),
  },
  sourceStaticField4BlankSquareSharedSpeed: {
    ...sourceBeginner2EarlyModels.staticField4,
    title: '静的フィールド(4)：正方形側の共有速度参照',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.staticField4.correctProgram,
      'j < Settings.speed',
      'j < @[Settings.speed]@'
    ),
  },
  sourceStaticField5BlankSharedUpdate: {
    ...sourceBeginner2EarlyModels.staticField5,
    title: '静的フィールド(5)：追加速度の共有更新',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.staticField5.correctProgram,
      'Settings.additionalSpeed++;',
      '@[Settings.additionalSpeed++]@;'
    ),
  },
  sourceStaticField5BlankStaticDeclaration: {
    ...sourceBeginner2EarlyModels.staticField5,
    title: '静的フィールド(5)：追加速度の静的宣言',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.staticField5.correctProgram,
      'static public int additionalSpeed',
      '@[static]@ public int additionalSpeed'
    ),
  },
  sourceStaticField6BlankCombinedSpeed: {
    ...sourceBeginner2EarlyModels.staticField6,
    title: '静的フィールド(6)：個別速度と共有速度の合成',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.staticField6.correctProgram,
      'i < this.base + Settings.additionalSpeed',
      'i < @[this.base + Settings.additionalSpeed]@'
    ),
  },
  sourceStaticField6BlankInstanceUpdate: {
    ...sourceBeginner2EarlyModels.staticField6,
    title: '静的フィールド(6)：１匹だけの速度更新',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2EarlyModels.staticField6.correctProgram,
      't1.base++;',
      '@[t1.base++]@;'
    ),
  },
} satisfies Record<string, JavaChallengeDefinition>;
