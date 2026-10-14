import { sourceBeginner2LateModels } from './sourceBeginner2LateModels';
import { replaceSourceOnce } from './sourceModels';
import type { JavaChallengeDefinition } from './types';

export const sourceBeginner2LateBlanks = {
  sourceInheritance1BlankParentClass: {
    ...sourceBeginner2LateModels.inheritance1,
    title: '継承(1)：継承する親クラス',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.inheritance1.correctProgram,
      'class CurveTurtle extends MyTurtle',
      'class CurveTurtle extends @[MyTurtle]@'
    ),
  },
  sourceInheritance1BlankInheritedCall: {
    ...sourceBeginner2LateModels.inheritance1,
    title: '継承(1)：継承したメソッドの呼び出し',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.inheritance1.correctProgram,
      'void drawCurve() {\n    this.drawLine();',
      'void drawCurve() {\n    @[this.drawLine()]@;'
    ),
  },
  sourceInheritance2BlankSuperConstructor: {
    ...sourceBeginner2LateModels.inheritance2,
    title: '継承(2)：親コンストラクターの呼び出し',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.inheritance2.correctProgram,
      'super(p, p);',
      '@[super(p, p)]@;'
    ),
  },
  sourceInheritance2BlankInheritedCall: {
    ...sourceBeginner2LateModels.inheritance2,
    title: '継承(2)：継承したメソッドの呼び出し',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.inheritance2.correctProgram,
      'void drawCurve() {\n    this.drawLine();',
      'void drawCurve() {\n    @[this.drawLine()]@;'
    ),
  },
  sourceInheritance3BlankSuperArguments: {
    ...sourceBeginner2LateModels.inheritance3,
    title: '継承(3)：親コンストラクターへ渡す座標',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.inheritance3.correctProgram,
      'super(p + 1, p + 2);',
      'super(@[p + 1, p + 2]@);'
    ),
  },
  sourceInheritance3BlankInheritedCall: {
    ...sourceBeginner2LateModels.inheritance3,
    title: '継承(3)：子のインスタンスから親メソッドを呼ぶ',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.inheritance3.correctProgram,
      't.drawCurve();\n    t.drawLine();',
      't.drawCurve();\n    @[t.drawLine()]@;'
    ),
  },
  sourceInheritance4BlankParentClass: {
    ...sourceBeginner2LateModels.inheritance4,
    title: '継承(4)：多段階継承の親クラス',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.inheritance4.correctProgram,
      'class SquareTurtle extends CurveTurtle',
      'class SquareTurtle extends @[CurveTurtle]@'
    ),
  },
  sourceInheritance4BlankInheritedCall: {
    ...sourceBeginner2LateModels.inheritance4,
    title: '継承(4)：親クラスの曲線描画を呼ぶ',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.inheritance4.correctProgram,
      'void drawSquare() {\n    this.drawCurve();',
      'void drawSquare() {\n    @[this.drawCurve()]@;'
    ),
  },
  sourceOverride1BlankDynamicCall: {
    ...sourceBeginner2LateModels.override1,
    title: 'オーバーライド(1)：オーバーライドされた長さを使う',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.override1.correctProgram,
      'i < this.length()',
      'i < @[this.length()]@'
    ),
  },
  sourceOverride1BlankOverrideSignature: {
    ...sourceBeginner2LateModels.override1,
    title: 'オーバーライド(1)：親と一致するメソッド宣言',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.override1.correctProgram,
      '@Override int length()',
      '@Override @[int length()]@'
    ),
  },
  sourceOverride2BlankParentCall: {
    ...sourceBeginner2LateModels.override2,
    title: 'オーバーライド(2)：親の戻り値を使う',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.override2.correctProgram,
      'return super.length() + 1;\n  }\n}\nclass SuperFastTurtle',
      'return @[super.length()]@ + 1;\n  }\n}\nclass SuperFastTurtle'
    ),
  },
  sourceOverride2BlankParentClass: {
    ...sourceBeginner2LateModels.override2,
    title: 'オーバーライド(2)：多段階オーバーライドの親クラス',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.override2.correctProgram,
      'class SuperFastTurtle extends FastTurtle',
      'class SuperFastTurtle @[extends FastTurtle]@'
    ),
  },
  sourceOverride3BlankParentDraw: {
    ...sourceBeginner2LateModels.override3,
    title: 'オーバーライド(3)：親の描画処理を呼ぶ',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.override3.correctProgram,
      'super.draw();\n    this.t.右を向く();',
      '@[super.draw()]@;\n    this.t.右を向く();'
    ),
  },
  sourceOverride3BlankParentLength: {
    ...sourceBeginner2LateModels.override3,
    title: 'オーバーライド(3)：親の長さを使って拡張する',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.override3.correctProgram,
      'return super.length() + 1;',
      'return @[super.length()]@ + 1;'
    ),
  },
  sourcePolymorphism1BlankArrayBaseType: {
    ...sourceBeginner2LateModels.polymorphism1,
    title: 'ポリモルフィズム(1)：異なる子クラスを格納する型',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.polymorphism1.correctProgram,
      'MyTurtle[] ts =',
      '@[MyTurtle[]]@ ts ='
    ),
  },
  sourcePolymorphism1BlankDynamicReceiver: {
    ...sourceBeginner2LateModels.polymorphism1,
    title: 'ポリモルフィズム(1)：配列の各要素からメソッドを呼ぶ',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.polymorphism1.correctProgram,
      'ts[i].drawLine();',
      '@[ts[i].drawLine()]@;'
    ),
  },
  sourcePolymorphism2BlankArrayBaseType: {
    ...sourceBeginner2LateModels.polymorphism2,
    title: 'ポリモルフィズム(2)：複数の子クラスをまとめる型',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.polymorphism2.correctProgram,
      'MyTurtle[] ts =',
      '@[MyTurtle[]]@ ts ='
    ),
  },
  sourcePolymorphism2BlankDynamicReceiver: {
    ...sourceBeginner2LateModels.polymorphism2,
    title: 'ポリモルフィズム(2)：実体に対応した描画メソッドを呼ぶ',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.polymorphism2.correctProgram,
      'ts[i].draw();',
      '@[ts[i].draw()]@;'
    ),
  },
  sourcePolymorphism3BlankArrayBaseType: {
    ...sourceBeginner2LateModels.polymorphism3,
    title: 'ポリモルフィズム(3)：親と子のインスタンスを格納する型',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.polymorphism3.correctProgram,
      'MyTurtle[] ts =',
      '@[MyTurtle[]]@ ts ='
    ),
  },
  sourcePolymorphism3BlankDynamicReceiver: {
    ...sourceBeginner2LateModels.polymorphism3,
    title: 'ポリモルフィズム(3)：向きを変えた後に動的に描画する',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.polymorphism3.correctProgram,
      'ts[i].t.右を向く();\n      ts[i].draw();',
      'ts[i].t.右を向く();\n      @[ts[i].draw()]@;'
    ),
  },
  sourceOverload1BlankDelegateOverload: {
    ...sourceBeginner2LateModels.overload1,
    title: 'オーバーロード(1)：引数付きのオーバーロードへ委譲する',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.overload1.correctProgram,
      'void drawLine() {\n    this.drawLine(2);',
      'void drawLine() {\n    @[this.drawLine(2)]@;'
    ),
  },
  sourceOverload1BlankParameterBound: {
    ...sourceBeginner2LateModels.overload1,
    title: 'オーバーロード(1)：受け取った歩数を繰り返しに使う',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceBeginner2LateModels.overload1.correctProgram, 'i < steps', 'i < @[steps]@'),
  },
  sourceOverload2BlankStringOverload: {
    ...sourceBeginner2LateModels.overload2,
    title: 'オーバーロード(2)：文字列を受け取るオーバーロード',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.overload2.correctProgram,
      'public void operate(String s)',
      'public void operate(@[String s]@)'
    ),
  },
  sourceOverload2BlankDelegateOverload: {
    ...sourceBeginner2LateModels.overload2,
    title: 'オーバーロード(2)：文字列命令を整数命令に変換する',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.overload2.correctProgram,
      'if (s.equals("up")) {\n      operate(0);',
      'if (s.equals("up")) {\n      @[operate(0)]@;'
    ),
  },
  sourceOverload3BlankThreeArgumentCall: {
    ...sourceBeginner2LateModels.overload3,
    title: 'オーバーロード(3)：3引数のオーバーロードを呼ぶ',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.overload3.correctProgram,
      't.drawLine(max(2, 3, 4));',
      't.drawLine(@[max(2, 3, 4)]@);'
    ),
  },
  sourceOverload3BlankMaximumCondition: {
    ...sourceBeginner2LateModels.overload3,
    title: 'オーバーロード(3)：3引数の最大値を判定する',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.overload3.correctProgram,
      'if (a >= b && a >= c)',
      'if (@[a >= b && a >= c]@)'
    ),
  },
  sourceOverload4BlankDelegateVertical: {
    ...sourceBeginner2LateModels.overload4,
    title: 'オーバーロード(4)：縦移動のオーバーロードを呼ぶ',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.overload4.correctProgram,
      'public void move(int dx, int dy) {\n    move(dy);',
      'public void move(int dx, int dy) {\n    @[move(dy)]@;'
    ),
  },
  sourceOverload4BlankHorizontalCondition: {
    ...sourceBeginner2LateModels.overload4,
    title: 'オーバーロード(4)：横方向の移動が必要か判定する',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.overload4.correctProgram,
      'if (dx != 0)',
      'if (@[dx != 0]@)'
    ),
  },
  sourceOverloadAndOverride1BlankDelegateOverload: {
    ...sourceBeginner2LateModels.overloadAndOverride1,
    title: 'オーバーロードとオーバーライド(1)：オーバーライドから引数付きメソッドを呼ぶ',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.overloadAndOverride1.correctProgram,
      'class MyTurtle2 extends MyTurtle {\n  @Override void drawLine() {\n    this.drawLine(4);',
      'class MyTurtle2 extends MyTurtle {\n  @Override void drawLine() {\n    @[this.drawLine(4)]@;'
    ),
  },
  sourceOverloadAndOverride1BlankDynamicReceiver: {
    ...sourceBeginner2LateModels.overloadAndOverride1,
    title: 'オーバーロードとオーバーライド(1)：基底型の変数から描画を呼ぶ',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.overloadAndOverride1.correctProgram,
      'm.t.右を向く();\n      m.drawLine();',
      'm.t.右を向く();\n      @[m.drawLine()]@;'
    ),
  },
  sourceOverloadAndOverride2BlankDelegateOverload: {
    ...sourceBeginner2LateModels.overloadAndOverride2,
    title: 'オーバーロードとオーバーライド(2)：引数なしメソッドから歩数を渡す',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.overloadAndOverride2.correctProgram,
      'class MyTurtle3 extends MyTurtle {\n  @Override void drawLine() {\n    this.drawLine(4);',
      'class MyTurtle3 extends MyTurtle {\n  @Override void drawLine() {\n    @[this.drawLine(4)]@;'
    ),
  },
  sourceOverloadAndOverride2BlankDynamicReceiver: {
    ...sourceBeginner2LateModels.overloadAndOverride2,
    title: 'オーバーロードとオーバーライド(2)：配列の実体に対応する描画を呼ぶ',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.overloadAndOverride2.correctProgram,
      'm.t.右を向く();\n      m.drawLine();',
      'm.t.右を向く();\n      @[m.drawLine()]@;'
    ),
  },
  sourceOverloadAndOverride3BlankSuperOverload: {
    ...sourceBeginner2LateModels.overloadAndOverride3,
    title: 'オーバーロードとオーバーライド(3)：親の引数付きメソッドを呼ぶ',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.overloadAndOverride3.correctProgram,
      'super.drawLine(steps * 2);',
      '@[super.drawLine(steps * 2)]@;'
    ),
  },
  sourceOverloadAndOverride3BlankOverrideSignature: {
    ...sourceBeginner2LateModels.overloadAndOverride3,
    title: 'オーバーロードとオーバーライド(3)：引数付きメソッドをオーバーライドする',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.overloadAndOverride3.correctProgram,
      '@Override void drawLine(int steps)',
      '@Override @[void drawLine(int steps)]@'
    ),
  },
  sourceException1BlankThrowException: {
    ...sourceBeginner2LateModels.exception1,
    title: '例外(1)：進めないときに例外を送出する',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.exception1.correctProgram,
      'throw new RuntimeException("前に進めない！");',
      '@[throw new RuntimeException("前に進めない！")]@;'
    ),
  },
  sourceException1BlankCatchType: {
    ...sourceBeginner2LateModels.exception1,
    title: '例外(1)：送出された例外を捕捉する',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.exception1.correctProgram,
      'catch (Exception e)',
      'catch (@[Exception]@ e)'
    ),
  },
  sourceException3BlankThrowCondition: {
    ...sourceBeginner2LateModels.exception3,
    title: '例外(3)：例外を送出する条件を補う',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.exception3.correctProgram,
      'if (!t.前に進めるか())',
      'if (@[!t.前に進めるか()]@)'
    ),
  },
  sourceException3BlankCatchRecovery: {
    ...sourceBeginner2LateModels.exception3,
    title: '例外(3)：例外後に進む方向を変更する',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.exception3.correctProgram,
      'catch (Exception e) {\n      m.t.右を向く();',
      'catch (Exception e) {\n      @[m.t.右を向く()]@;'
    ),
  },
  sourceException4BlankRethrow: {
    ...sourceBeginner2LateModels.exception4,
    title: '例外(4)：捕捉した例外を呼び出し元へ再送出する',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceBeginner2LateModels.exception4.correctProgram, 'throw e;', '@[throw e]@;'),
  },
  sourceException4BlankInnerCatchType: {
    ...sourceBeginner2LateModels.exception4,
    title: '例外(4)：内部で送出した例外を捕捉する',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.exception4.correctProgram,
      'catch (RuntimeException e)',
      'catch (@[RuntimeException]@ e)'
    ),
  },
  sourceOriginalException1BlankExceptionBase: {
    ...sourceBeginner2LateModels.originalException1,
    title: '独自に定義した例外(1)：独自の検査例外を定義する',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.originalException1.correctProgram,
      'class OutOfBoardException extends Exception',
      'class OutOfBoardException @[extends Exception]@'
    ),
  },
  sourceOriginalException1BlankThrowCustom: {
    ...sourceBeginner2LateModels.originalException1,
    title: '独自に定義した例外(1)：独自例外を生成して送出する',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.originalException1.correctProgram,
      'throw new OutOfBoardException();',
      '@[throw new OutOfBoardException()]@;'
    ),
  },
  sourceOriginalException2BlankThrowsDeclaration: {
    ...sourceBeginner2LateModels.originalException2,
    title: '独自に定義した例外(2)：呼び出し元へ渡す検査例外を宣言する',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.originalException2.correctProgram,
      'void drawLine() throws OutOfBoardException',
      'void drawLine() @[throws OutOfBoardException]@'
    ),
  },
  sourceOriginalException2BlankCatchCustom: {
    ...sourceBeginner2LateModels.originalException2,
    title: '独自に定義した例外(2)：呼び出し元で独自例外を捕捉する',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.originalException2.correctProgram,
      'catch (OutOfBoardException e)',
      'catch (@[OutOfBoardException]@ e)'
    ),
  },
  sourceOriginalException3BlankThrowsDeclaration: {
    ...sourceBeginner2LateModels.originalException3,
    title: '独自に定義した例外(3)：2種類の検査例外を宣言する',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.originalException3.correctProgram,
      'throws OutOfBoardException, ColoredException',
      '@[throws OutOfBoardException, ColoredException]@'
    ),
  },
  sourceOriginalException3BlankThrowColored: {
    ...sourceBeginner2LateModels.originalException3,
    title: '独自に定義した例外(3)：塗られたマスに対する例外を送出する',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.originalException3.correctProgram,
      'throw new ColoredException();',
      '@[throw new ColoredException()]@;'
    ),
  },
  sourceOriginalException4BlankCatchCommonBase: {
    ...sourceBeginner2LateModels.originalException4,
    title: '独自に定義した例外(4)：複数の例外を共通の親型で捕捉する',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.originalException4.correctProgram,
      'catch (Exception e)',
      'catch (@[Exception]@ e)'
    ),
  },
  sourceOriginalException4BlankThrowCondition: {
    ...sourceBeginner2LateModels.originalException4,
    title: '独自に定義した例外(4)：盤面外へ進む前に例外を送出する',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.originalException4.correctProgram,
      'if (!this.t.前に進めるか())',
      'if (@[!this.t.前に進めるか()]@)'
    ),
  },
  sourceOriginalException5BlankCatchColored: {
    ...sourceBeginner2LateModels.originalException5,
    title: '独自に定義した例外(5)：塗られたマスへの例外を捕捉する',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.originalException5.correctProgram,
      'catch (ColoredException e)',
      'catch (@[ColoredException]@ e)'
    ),
  },
  sourceOriginalException5BlankThrowsDeclaration: {
    ...sourceBeginner2LateModels.originalException5,
    title: '独自に定義した例外(5)：描画から送出する検査例外を宣言する',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.originalException5.correctProgram,
      'throws OutOfBoardException, ColoredException',
      '@[throws OutOfBoardException, ColoredException]@'
    ),
  },
  sourceTwoDimensionalArray1BlankCommandSelector: {
    ...sourceBeginner2LateModels.twoDimensionalArray1,
    title: '二次元配列(1)：行から命令番号を取り出す',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.twoDimensionalArray1.correctProgram,
      'switch (arr[i][0])',
      'switch (@[arr[i][0]]@)'
    ),
  },
  sourceTwoDimensionalArray1BlankRepeatCount: {
    ...sourceBeginner2LateModels.twoDimensionalArray1,
    title: '二次元配列(1)：行から繰り返し回数を取り出す',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.twoDimensionalArray1.correctProgram,
      'int c = arr[i][1];',
      'int c = @[arr[i][1]]@;'
    ),
  },
  sourceTwoDimensionalArray2BlankCommandSelector: {
    ...sourceBeginner2LateModels.twoDimensionalArray2,
    title: '二次元配列(2)：長さの異なる行から命令を読む',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.twoDimensionalArray2.correctProgram,
      'switch (arr[i][0])',
      'switch (@[arr[i][0]]@)'
    ),
  },
  sourceTwoDimensionalArray2BlankForwardArgument: {
    ...sourceBeginner2LateModels.twoDimensionalArray2,
    title: '二次元配列(2)：前進命令の行から歩数を読む',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.twoDimensionalArray2.correctProgram,
      'int c = arr[i][1];',
      'int c = @[arr[i][1]]@;'
    ),
  },
  sourceTwoDimensionalArray3BlankCommandRow: {
    ...sourceBeginner2LateModels.twoDimensionalArray3,
    title: '二次元配列(3)：命令の行全体をメソッドへ渡す',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.twoDimensionalArray3.correctProgram,
      'moveTurtle(t, arr[i]);',
      'moveTurtle(t, @[arr[i]]@);'
    ),
  },
  sourceTwoDimensionalArray3BlankRowParameter: {
    ...sourceBeginner2LateModels.twoDimensionalArray3,
    title: '二次元配列(3)：行を受け取る配列引数を宣言する',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.twoDimensionalArray3.correctProgram,
      'moveTurtle(Turtle t, int[] command)',
      'moveTurtle(Turtle t, @[int[] command]@)'
    ),
  },
  sourceTwoDimensionalArray4BlankCoordinates: {
    ...sourceBeginner2LateModels.twoDimensionalArray4,
    title: '二次元配列(4)：配置命令の行から座標を読む',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.twoDimensionalArray4.correctProgram,
      'new Turtle(arr[i][1], arr[i][2])',
      'new Turtle(@[arr[i][1], arr[i][2]]@)'
    ),
  },
  sourceTwoDimensionalArray4BlankCommandSelector: {
    ...sourceBeginner2LateModels.twoDimensionalArray4,
    title: '二次元配列(4)：行から配置・移動命令を読む',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.twoDimensionalArray4.correctProgram,
      'int command = arr[i][0];',
      'int command = @[arr[i][0]]@;'
    ),
  },
  sourceTwoDimensionalArray6BlankRowLength: {
    ...sourceBeginner2LateModels.twoDimensionalArray6,
    title: '二次元配列(6)：亀ごとの命令数を使う',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.twoDimensionalArray6.correctProgram,
      'i < commands[nthTurtle].length',
      'i < @[commands[nthTurtle].length]@'
    ),
  },
  sourceTwoDimensionalArray6BlankCommandElement: {
    ...sourceBeginner2LateModels.twoDimensionalArray6,
    title: '二次元配列(6)：亀と命令の添字を使い分ける',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.twoDimensionalArray6.correctProgram,
      'int command = commands[nthTurtle][i];',
      'int command = @[commands[nthTurtle][i]]@;'
    ),
  },
  sourceThreeDimensionalArray1BlankCoordinates: {
    ...sourceBeginner2LateModels.threeDimensionalArray1,
    title: '三次元配列(1)：各亀の先頭行から座標を読む',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.threeDimensionalArray1.correctProgram,
      'new Turtle(a[i][0][0], a[i][0][1])',
      'new Turtle(@[a[i][0][0], a[i][0][1]]@)'
    ),
  },
  sourceThreeDimensionalArray1BlankCommandSelector: {
    ...sourceBeginner2LateModels.threeDimensionalArray1,
    title: '三次元配列(1)：亀・命令・要素の添字を使う',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.threeDimensionalArray1.correctProgram,
      'switch (a[i][j][0])',
      'switch (@[a[i][j][0]]@)'
    ),
  },
  sourceThreeDimensionalArray2BlankCommandRows: {
    ...sourceBeginner2LateModels.threeDimensionalArray2,
    title: '三次元配列(2)：亀ごとの命令行数を使う',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.threeDimensionalArray2.correctProgram,
      'j < arr[i].length',
      'j < @[arr[i].length]@'
    ),
  },
  sourceThreeDimensionalArray2BlankRepeatCount: {
    ...sourceBeginner2LateModels.threeDimensionalArray2,
    title: '三次元配列(2)：3次元配列から繰り返し回数を読む',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.threeDimensionalArray2.correctProgram,
      'int times = arr[i][j][1];',
      'int times = @[arr[i][j][1]]@;'
    ),
  },
  sourceThreeDimensionalArray3BlankCommandLength: {
    ...sourceBeginner2LateModels.threeDimensionalArray3,
    title: '三次元配列(3)：命令配列の長さを使う',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.threeDimensionalArray3.correctProgram,
      'j < arr[i][1].length',
      'j < @[arr[i][1].length]@'
    ),
  },
  sourceThreeDimensionalArray3BlankCommandElement: {
    ...sourceBeginner2LateModels.threeDimensionalArray3,
    title: '三次元配列(3)：座標行と命令行を区別する',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.threeDimensionalArray3.correctProgram,
      'int command = arr[i][1][j];',
      'int command = @[arr[i][1][j]]@;'
    ),
  },
  sourceThreeDimensionalArray4BlankCoordinates: {
    ...sourceBeginner2LateModels.threeDimensionalArray4,
    title: '三次元配列(4)：各亀の座標を3次元配列から読む',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.threeDimensionalArray4.correctProgram,
      'new Turtle(arr[i][0][0], arr[i][0][1])',
      'new Turtle(@[arr[i][0][0], arr[i][0][1]]@)'
    ),
  },
  sourceThreeDimensionalArray4BlankCommandLength: {
    ...sourceBeginner2LateModels.threeDimensionalArray4,
    title: '三次元配列(4)：長さの異なる命令列を走査する',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceBeginner2LateModels.threeDimensionalArray4.correctProgram,
      'j < arr[i][1].length',
      'j < @[arr[i][1].length]@'
    ),
  },
} satisfies Record<string, JavaChallengeDefinition>;
