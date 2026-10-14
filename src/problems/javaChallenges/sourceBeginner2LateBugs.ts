import { sourceBeginner2LateModels } from './sourceBeginner2LateModels';
import { replaceSourceOnce } from './sourceModels';
import type { JavaChallengeDefinition } from './types';

export const sourceBeginner2LateBugs = {
  sourceInheritance1BugInheritedCall: {
    ...sourceBeginner2LateModels.inheritance1,
    title: '継承(1)：継承した描画メソッドの呼び分けを修正',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.inheritance1.correctProgram,
      't.drawCurve();',
      't.drawLine();'
    ),
  },
  sourceInheritance1BugParentRelation: {
    ...sourceBeginner2LateModels.inheritance1,
    title: '継承(1)：親クラスの継承指定を修正',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.inheritance1.correctProgram,
      'class CurveTurtle extends MyTurtle',
      'class CurveTurtle implements MyTurtle'
    ),
  },
  sourceInheritance2BugInheritedCall: {
    ...sourceBeginner2LateModels.inheritance2,
    title: '継承(2)：継承した描画メソッドの呼び分けを修正',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.inheritance2.correctProgram,
      't.drawCurve();',
      't.drawLine();'
    ),
  },
  sourceInheritance2BugParentRelation: {
    ...sourceBeginner2LateModels.inheritance2,
    title: '継承(2)：親クラスの継承指定を修正',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.inheritance2.correctProgram,
      'class CurveTurtle extends MyTurtle',
      'class CurveTurtle implements MyTurtle'
    ),
  },
  sourceInheritance3BugInheritedCall: {
    ...sourceBeginner2LateModels.inheritance3,
    title: '継承(3)：継承した描画メソッドの呼び分けを修正',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.inheritance3.correctProgram,
      't.drawCurve();',
      't.drawLine();'
    ),
  },
  sourceInheritance3BugParentRelation: {
    ...sourceBeginner2LateModels.inheritance3,
    title: '継承(3)：親クラスの継承指定を修正',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.inheritance3.correctProgram,
      'class CurveTurtle extends MyTurtle',
      'class CurveTurtle implements MyTurtle'
    ),
  },
  sourceInheritance4BugInheritedCall: {
    ...sourceBeginner2LateModels.inheritance4,
    title: '継承(4)：多段階継承の描画呼び出しを修正',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.inheritance4.correctProgram,
      't.drawSquare();',
      't.drawCurve();'
    ),
  },
  sourceInheritance4BugParentRelation: {
    ...sourceBeginner2LateModels.inheritance4,
    title: '継承(4)：多段階継承の親クラス指定を修正',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.inheritance4.correctProgram,
      'class SquareTurtle extends CurveTurtle',
      'class SquareTurtle implements CurveTurtle'
    ),
  },
  sourceOverride1BugLoopPredicate: {
    ...sourceBeginner2LateModels.override1,
    title: 'オーバーライド(1)：オーバーライドされた長さと繰り返し条件を修正',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.override1.correctProgram,
      'i < this.length()',
      'i > this.length()'
    ),
  },
  sourceOverride1BugReturnType: {
    ...sourceBeginner2LateModels.override1,
    title: 'オーバーライド(1)：オーバーライドの戻り値型を修正',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.override1.correctProgram,
      '@Override int length()',
      '@Override boolean length()'
    ),
  },
  sourceOverride2BugParentDelegation: {
    ...sourceBeginner2LateModels.override2,
    title: 'オーバーライド(2)：多段階オーバーライドの親の戻り値を修正',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.override2.correctProgram,
      'return super.length() + 1;\n  }\n}\nclass SuperFastTurtle',
      'return super.length();\n  }\n}\nclass SuperFastTurtle'
    ),
  },
  sourceOverride2BugStaticOverride: {
    ...sourceBeginner2LateModels.override2,
    title: 'オーバーライド(2)：インスタンスメソッドのオーバーライドを修正',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.override2.correctProgram,
      'class SuperFastTurtle extends FastTurtle {\n  @Override int length()',
      'class SuperFastTurtle extends FastTurtle {\n  @Override static int length()'
    ),
  },
  sourceOverride3BugParentDraw: {
    ...sourceBeginner2LateModels.override3,
    title: 'オーバーライド(3)：オーバーライドから親の描画を呼ぶを修正',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.override3.correctProgram,
      'super.draw();\n    this.t.右を向く();',
      'this.t.右を向く();'
    ),
  },
  sourceOverride3BugOverrideParameters: {
    ...sourceBeginner2LateModels.override3,
    title: 'オーバーライド(3)：親と一致するオーバーライドの引数を修正',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.override3.correctProgram,
      '@Override void draw()',
      '@Override void draw(int steps)'
    ),
  },
  sourcePolymorphism1BugArrayTraversal: {
    ...sourceBeginner2LateModels.polymorphism1,
    title: 'ポリモルフィズム(1)：基底型配列の全要素を描画するを修正',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.polymorphism1.correctProgram,
      'i < ts.length',
      'i < ts.length - 1'
    ),
  },
  sourcePolymorphism1BugArrayBaseType: {
    ...sourceBeginner2LateModels.polymorphism1,
    title: 'ポリモルフィズム(1)：異なる実体を格納する配列の型を修正',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.polymorphism1.correctProgram,
      'MyTurtle[] ts =',
      'FastTurtle[] ts ='
    ),
  },
  sourcePolymorphism2BugArrayTraversal: {
    ...sourceBeginner2LateModels.polymorphism2,
    title: 'ポリモルフィズム(2)：基底型配列の全要素を描画するを修正',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.polymorphism2.correctProgram,
      'i < ts.length',
      'i < ts.length - 1'
    ),
  },
  sourcePolymorphism2BugArrayBaseType: {
    ...sourceBeginner2LateModels.polymorphism2,
    title: 'ポリモルフィズム(2)：異なる実体を格納する配列の型を修正',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.polymorphism2.correctProgram,
      'MyTurtle[] ts =',
      'FastTurtle[] ts ='
    ),
  },
  sourcePolymorphism3BugArrayTraversal: {
    ...sourceBeginner2LateModels.polymorphism3,
    title: 'ポリモルフィズム(3)：基底型配列の全要素を描画するを修正',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.polymorphism3.correctProgram,
      'i < ts.length',
      'i < ts.length - 1'
    ),
  },
  sourcePolymorphism3BugArrayBaseType: {
    ...sourceBeginner2LateModels.polymorphism3,
    title: 'ポリモルフィズム(3)：異なる実体を格納する配列の型を修正',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.polymorphism3.correctProgram,
      'MyTurtle[] ts =',
      'FastTurtle[] ts ='
    ),
  },
  sourceOverload1BugOverloadChoice: {
    ...sourceBeginner2LateModels.overload1,
    title: 'オーバーロード(1)：引数付きと引数なしの呼び分けを修正',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.overload1.correctProgram,
      'this.drawLine(3);',
      'this.drawLine();'
    ),
  },
  sourceOverload1BugParameterType: {
    ...sourceBeginner2LateModels.overload1,
    title: 'オーバーロード(1)：オーバーロードの歩数引数の型を修正',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.overload1.correctProgram,
      'void drawLine(int steps)',
      'void drawLine(boolean steps)'
    ),
  },
  sourceOverload2BugStringDispatch: {
    ...sourceBeginner2LateModels.overload2,
    title: 'オーバーロード(2)：文字列命令から整数命令への委譲を修正',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.overload2.correctProgram,
      'if (s.equals("up")) {\n      operate(0);',
      'if (s.equals("up")) {\n      operate(1);'
    ),
  },
  sourceOverload2BugDuplicateSignature: {
    ...sourceBeginner2LateModels.overload2,
    title: 'オーバーロード(2)：オーバーロードの引数型を修正',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.overload2.correctProgram,
      'public void operate(String s)',
      'public void operate(int s)'
    ),
  },
  sourceOverload3BugMaximumPredicate: {
    ...sourceBeginner2LateModels.overload3,
    title: 'オーバーロード(3)：最大値オーバーロードの比較条件を修正',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.overload3.correctProgram,
      'if (a > b) return a;',
      'if (a < b) return a;'
    ),
  },
  sourceOverload3BugOverloadArity: {
    ...sourceBeginner2LateModels.overload3,
    title: 'オーバーロード(3)：最大値オーバーロードの引数個数を修正',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.overload3.correctProgram,
      't.drawLine(max(2, 3, 4));',
      't.drawLine(max(2, 3, 4, 1));'
    ),
  },
  sourceOverload4BugHorizontalCondition: {
    ...sourceBeginner2LateModels.overload4,
    title: 'オーバーロード(4)：横移動が必要な条件を修正',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.overload4.correctProgram,
      'if (dx != 0)',
      'if (dx == 0)'
    ),
  },
  sourceOverload4BugParameterType: {
    ...sourceBeginner2LateModels.overload4,
    title: 'オーバーロード(4)：移動オーバーロードの縦方向引数を修正',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.overload4.correctProgram,
      'public void move(int dy)',
      'public void move(boolean dy)'
    ),
  },
  sourceOverloadAndOverride1BugStaticDispatchChoice: {
    ...sourceBeginner2LateModels.overloadAndOverride1,
    title: 'オーバーロードとオーバーライド(1)：動的な引数なしメソッドの呼び出しを修正',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.overloadAndOverride1.correctProgram,
      'm.drawLine();',
      'm.drawLine(2);'
    ),
  },
  sourceOverloadAndOverride1BugOverrideParameters: {
    ...sourceBeginner2LateModels.overloadAndOverride1,
    title: 'オーバーロードとオーバーライド(1)：オーバーロードとオーバーライドの引数型を修正',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.overloadAndOverride1.correctProgram,
      'class MyTurtle3 extends MyTurtle {\n  @Override void drawLine()',
      'class MyTurtle3 extends MyTurtle {\n  @Override void drawLine(boolean steps)'
    ),
  },
  sourceOverloadAndOverride2BugStaticDispatchChoice: {
    ...sourceBeginner2LateModels.overloadAndOverride2,
    title: 'オーバーロードとオーバーライド(2)：動的な引数なしメソッドの呼び出しを修正',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.overloadAndOverride2.correctProgram,
      'm.drawLine();',
      'm.drawLine(2);'
    ),
  },
  sourceOverloadAndOverride2BugOverrideParameters: {
    ...sourceBeginner2LateModels.overloadAndOverride2,
    title: 'オーバーロードとオーバーライド(2)：オーバーロードとオーバーライドの引数型を修正',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.overloadAndOverride2.correctProgram,
      'class MyTurtle3 extends MyTurtle {\n  @Override void drawLine()',
      'class MyTurtle3 extends MyTurtle {\n  @Override void drawLine(boolean steps)'
    ),
  },
  sourceOverloadAndOverride3BugParentArgument: {
    ...sourceBeginner2LateModels.overloadAndOverride3,
    title: 'オーバーロードとオーバーライド(3)：親メソッドに渡す歩数の計算を修正',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.overloadAndOverride3.correctProgram,
      'super.drawLine(steps * 2);',
      'super.drawLine(steps);'
    ),
  },
  sourceOverloadAndOverride3BugOverrideParameters: {
    ...sourceBeginner2LateModels.overloadAndOverride3,
    title: 'オーバーロードとオーバーライド(3)：親メソッドと一致する引数型を修正',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.overloadAndOverride3.correctProgram,
      '@Override void drawLine(int steps)',
      '@Override void drawLine(boolean steps)'
    ),
  },
  sourceException1BugThrowCondition: {
    ...sourceBeginner2LateModels.exception1,
    title: '例外(1)：境界検査と例外送出条件を修正',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.exception1.correctProgram,
      'if (!t.前に進めるか())',
      'if (t.前に進めるか())'
    ),
  },
  sourceException1BugCatchType: {
    ...sourceBeginner2LateModels.exception1,
    title: '例外(1)：捕捉可能な例外の型を修正',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.exception1.correctProgram,
      'catch (Exception e)',
      'catch (String e)'
    ),
  },
  sourceException3BugRecoveryDirection: {
    ...sourceBeginner2LateModels.exception3,
    title: '例外(3)：捕捉後の方向の復元を修正',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.exception3.correctProgram,
      'm.t.左を向く();',
      'm.t.右を向く();'
    ),
  },
  sourceException3BugThrowOperand: {
    ...sourceBeginner2LateModels.exception3,
    title: '例外(3)：throwする例外オブジェクトを修正',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.exception3.correctProgram,
      'throw new RuntimeException("前に進めない！");',
      'throw "前に進めない！";'
    ),
  },
  sourceException4BugRethrowPropagation: {
    ...sourceBeginner2LateModels.exception4,
    title: '例外(4)：内側のcatchからの例外伝播を修正',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(sourceBeginner2LateModels.exception4.correctProgram, 'throw e;', 'return;'),
  },
  sourceException4BugCatchType: {
    ...sourceBeginner2LateModels.exception4,
    title: '例外(4)：再送出する例外の捕捉型を修正',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.exception4.correctProgram,
      'catch (RuntimeException e)',
      'catch (String e)'
    ),
  },
  sourceOriginalException1BugCatchRecovery: {
    ...sourceBeginner2LateModels.originalException1,
    title: '独自に定義した例外(1)：独自例外を捕捉した後の前進を修正',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.originalException1.correctProgram,
      'this.t.右を向く();\n      this.t.前に進む();',
      'this.t.右を向く();'
    ),
  },
  sourceOriginalException1BugExceptionHierarchy: {
    ...sourceBeginner2LateModels.originalException1,
    title: '独自に定義した例外(1)：独自例外の親クラスを修正',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.originalException1.correctProgram,
      'class OutOfBoardException extends Exception',
      'class OutOfBoardException extends Object'
    ),
  },
  sourceOriginalException2BugThrowCondition: {
    ...sourceBeginner2LateModels.originalException2,
    title: '独自に定義した例外(2)：検査例外を呼び出し元へ渡す条件を修正',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.originalException2.correctProgram,
      'if (!this.t.前に進めるか())',
      'if (this.t.前に進めるか())'
    ),
  },
  sourceOriginalException2BugThrowsDeclaration: {
    ...sourceBeginner2LateModels.originalException2,
    title: '独自に定義した例外(2)：検査例外のthrows宣言を修正',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.originalException2.correctProgram,
      'void drawLine() throws OutOfBoardException',
      'void drawLine()'
    ),
  },
  sourceOriginalException3BugCatchRecovery: {
    ...sourceBeginner2LateModels.originalException3,
    title: '独自に定義した例外(3)：例外種別に応じた復帰方向を修正',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.originalException3.correctProgram,
      'catch (ColoredException e) {\n      m.t.前に進む();\n      m.t.左を向く();',
      'catch (ColoredException e) {\n      m.t.前に進む();\n      m.t.右を向く();'
    ),
  },
  sourceOriginalException3BugThrowsCoverage: {
    ...sourceBeginner2LateModels.originalException3,
    title: '独自に定義した例外(3)：複数の検査例外を宣言するを修正',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.originalException3.correctProgram,
      'throws OutOfBoardException, ColoredException',
      'throws OutOfBoardException'
    ),
  },
  sourceOriginalException4BugCatchRecovery: {
    ...sourceBeginner2LateModels.originalException4,
    title: '独自に定義した例外(4)：例外後の戻る距離を修正',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.originalException4.correctProgram,
      'm.t.左を向く();\n      m.t.左を向く();\n      m.t.前に進む();',
      'm.t.左を向く();\n      m.t.左を向く();'
    ),
  },
  sourceOriginalException4BugCatchType: {
    ...sourceBeginner2LateModels.originalException4,
    title: '独自に定義した例外(4)：複数の独自例外を捕捉する型を修正',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.originalException4.correctProgram,
      'catch (Exception e)',
      'catch (String e)'
    ),
  },
  sourceOriginalException5BugCatchRecovery: {
    ...sourceBeginner2LateModels.originalException5,
    title: '独自に定義した例外(5)：塗られたマスの例外後の移動を修正',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.originalException5.correctProgram,
      'catch (ColoredException e) {\n        m.t.前に進む();\n        m.t.前に進む();',
      'catch (ColoredException e) {\n        m.t.前に進む();'
    ),
  },
  sourceOriginalException5BugCatchOrdering: {
    ...sourceBeginner2LateModels.originalException5,
    title: '独自に定義した例外(5)：独自例外のcatch節の重複を修正',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.originalException5.correctProgram,
      'catch (ColoredException e)',
      'catch (OutOfBoardException e)'
    ),
  },
  sourceTwoDimensionalArray1BugRowTraversal: {
    ...sourceBeginner2LateModels.twoDimensionalArray1,
    title: '二次元配列(1)：配列のすべての命令行を読むを修正',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.twoDimensionalArray1.correctProgram,
      'i < arr.length',
      'i < arr.length - 1'
    ),
  },
  sourceTwoDimensionalArray1BugSwitchSelector: {
    ...sourceBeginner2LateModels.twoDimensionalArray1,
    title: '二次元配列(1)：命令行からswitchの選択値を読むを修正',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.twoDimensionalArray1.correctProgram,
      'switch (arr[i][0])',
      'switch (arr[i])'
    ),
  },
  sourceTwoDimensionalArray2BugRowTraversal: {
    ...sourceBeginner2LateModels.twoDimensionalArray2,
    title: '二次元配列(2)：配列のすべての命令行を読むを修正',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.twoDimensionalArray2.correctProgram,
      'i < arr.length',
      'i < arr.length - 1'
    ),
  },
  sourceTwoDimensionalArray2BugSwitchSelector: {
    ...sourceBeginner2LateModels.twoDimensionalArray2,
    title: '二次元配列(2)：命令行からswitchの選択値を読むを修正',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.twoDimensionalArray2.correctProgram,
      'switch (arr[i][0])',
      'switch (arr[i])'
    ),
  },
  sourceTwoDimensionalArray3BugCommandSelector: {
    ...sourceBeginner2LateModels.twoDimensionalArray3,
    title: '二次元配列(3)：左折命令に対応する動作を修正',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.twoDimensionalArray3.correctProgram,
      'case TURN_LEFT:\n        t.左を向く();',
      'case TURN_LEFT:\n        t.右を向く();'
    ),
  },
  sourceTwoDimensionalArray3BugRowArgument: {
    ...sourceBeginner2LateModels.twoDimensionalArray3,
    title: '二次元配列(3)：命令行全体をメソッドへ渡すを修正',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.twoDimensionalArray3.correctProgram,
      'moveTurtle(t, arr[i]);',
      'moveTurtle(t, arr[i][0]);'
    ),
  },
  sourceTwoDimensionalArray4BugRowTraversal: {
    ...sourceBeginner2LateModels.twoDimensionalArray4,
    title: '二次元配列(4)：最後の命令行まで実行するを修正',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.twoDimensionalArray4.correctProgram,
      'i < arr.length',
      'i < arr.length - 1'
    ),
  },
  sourceTwoDimensionalArray4BugCommandElement: {
    ...sourceBeginner2LateModels.twoDimensionalArray4,
    title: '二次元配列(4)：命令番号を行から取り出すを修正',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.twoDimensionalArray4.correctProgram,
      'int command = arr[i][0];',
      'int command = arr[i];'
    ),
  },
  sourceTwoDimensionalArray6BugJaggedTraversal: {
    ...sourceBeginner2LateModels.twoDimensionalArray6,
    title: '二次元配列(6)：亀ごとの命令列を最後まで読むを修正',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.twoDimensionalArray6.correctProgram,
      'i < commands[nthTurtle].length',
      'i < commands[nthTurtle].length - 1'
    ),
  },
  sourceTwoDimensionalArray6BugCommandElement: {
    ...sourceBeginner2LateModels.twoDimensionalArray6,
    title: '二次元配列(6)：2つの添字で命令を取り出すを修正',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.twoDimensionalArray6.correctProgram,
      'int command = commands[nthTurtle][i];',
      'int command = commands[nthTurtle];'
    ),
  },
  sourceThreeDimensionalArray1BugCommandCount: {
    ...sourceBeginner2LateModels.threeDimensionalArray1,
    title: '三次元配列(1)：3次元配列から命令の回数を読むを修正',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.threeDimensionalArray1.correctProgram,
      'int c = a[i][j][1];',
      'int c = a[i][j][0];'
    ),
  },
  sourceThreeDimensionalArray1BugSwitchSelector: {
    ...sourceBeginner2LateModels.threeDimensionalArray1,
    title: '三次元配列(1)：3次元配列から命令番号を読むを修正',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.threeDimensionalArray1.correctProgram,
      'switch (a[i][j][0])',
      'switch (a[i][j])'
    ),
  },
  sourceThreeDimensionalArray2BugCommandCount: {
    ...sourceBeginner2LateModels.threeDimensionalArray2,
    title: '三次元配列(2)：命令番号と繰り返し回数の区別を修正',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.threeDimensionalArray2.correctProgram,
      'int times = arr[i][j][1];',
      'int times = arr[i][j][0];'
    ),
  },
  sourceThreeDimensionalArray2BugCommandElement: {
    ...sourceBeginner2LateModels.threeDimensionalArray2,
    title: '三次元配列(2)：命令行から整数要素を取り出すを修正',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.threeDimensionalArray2.correctProgram,
      'int command = arr[i][j][0];',
      'int command = arr[i][j];'
    ),
  },
  sourceThreeDimensionalArray3BugCommandLength: {
    ...sourceBeginner2LateModels.threeDimensionalArray3,
    title: '三次元配列(3)：亀ごとの命令列の長さを修正',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.threeDimensionalArray3.correctProgram,
      'j < arr[i][1].length',
      'j < arr[i].length'
    ),
  },
  sourceThreeDimensionalArray3BugCommandElement: {
    ...sourceBeginner2LateModels.threeDimensionalArray3,
    title: '三次元配列(3)：3つの添字で命令を取り出すを修正',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.threeDimensionalArray3.correctProgram,
      'int command = arr[i][1][j];',
      'int command = arr[i][1];'
    ),
  },
  sourceThreeDimensionalArray4BugCommandLength: {
    ...sourceBeginner2LateModels.threeDimensionalArray4,
    title: '三次元配列(4)：亀ごとの命令列の長さを修正',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.threeDimensionalArray4.correctProgram,
      'j < arr[i][1].length',
      'j < arr[i].length'
    ),
  },
  sourceThreeDimensionalArray4BugCommandElement: {
    ...sourceBeginner2LateModels.threeDimensionalArray4,
    title: '三次元配列(4)：3つの添字で命令を取り出すを修正',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.threeDimensionalArray4.correctProgram,
      'int command = arr[i][1][j];',
      'int command = arr[i][1];'
    ),
  },
} satisfies Record<string, JavaChallengeDefinition>;
