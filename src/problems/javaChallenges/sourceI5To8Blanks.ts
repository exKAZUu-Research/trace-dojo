import { sourceI5To8Models } from './sourceI5To8Models';
import { replaceSourceOnce } from './sourceModels';
import type { JavaChallengeDefinition } from './types';

export const sourceI5To8Blanks = {
  sourceElseIf1BlankInitialPredicate: {
    ...sourceI5To8Models.elseIf1,
    title: 'else if文を使おう(1)：最初の分岐条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceI5To8Models.elseIf1.correctProgram, 'i < 2', '@[i < 2]@'),
  },
  sourceElseIf1BlankElsePredicate: {
    ...sourceI5To8Models.elseIf1,
    title: 'else if文を使おう(1)：次の分岐条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceI5To8Models.elseIf1.correctProgram, 'i == 2', '@[i == 2]@'),
  },
  sourceElseIf2BlankInitialPredicate: {
    ...sourceI5To8Models.elseIf2,
    title: 'else if文を使おう(2)：最初の分岐条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceI5To8Models.elseIf2.correctProgram, 'i % 4 == 0', '@[i % 4 == 0]@'),
  },
  sourceElseIf2BlankElsePredicate: {
    ...sourceI5To8Models.elseIf2,
    title: 'else if文を使おう(2)：次の分岐条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceI5To8Models.elseIf2.correctProgram, 'i % 4 == 1', '@[i % 4 == 1]@'),
  },
  sourceElseIf3BlankFirstTurnPredicate: {
    ...sourceI5To8Models.elseIf3,
    title: 'else if文を使おう(3)：左折する条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceI5To8Models.elseIf3.correctProgram, 'i == 2', '@[i == 2]@'),
  },
  sourceElseIf3BlankSecondTurnPredicate: {
    ...sourceI5To8Models.elseIf3,
    title: 'else if文を使おう(3)：右折する条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceI5To8Models.elseIf3.correctProgram, 'i == 4', '@[i == 4]@'),
  },
  sourceElseIf4BlankInitialPredicate: {
    ...sourceI5To8Models.elseIf4,
    title: 'else if文を使おう(4)：最初の分岐条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceI5To8Models.elseIf4.correctProgram, 'i % 5 == 0', '@[i % 5 == 0]@'),
  },
  sourceElseIf4BlankElsePredicate: {
    ...sourceI5To8Models.elseIf4,
    title: 'else if文を使おう(4)：次の分岐条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceI5To8Models.elseIf4.correctProgram, 'i % 5 == 1', '@[i % 5 == 1]@'),
  },
  sourceElseIf5BlankRightPredicate: {
    ...sourceI5To8Models.elseIf5,
    title: 'else if文を使おう(5)：右折する条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceI5To8Models.elseIf5.correctProgram, 'i % 5 == 1', '@[i % 5 == 1]@'),
  },
  sourceElseIf5BlankLeftPredicate: {
    ...sourceI5To8Models.elseIf5,
    title: 'else if文を使おう(5)：左折する条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceI5To8Models.elseIf5.correctProgram, 'i % 5 == 3', '@[i % 5 == 3]@'),
  },
  sourceSwitch1BlankSelector: {
    ...sourceI5To8Models.switch1,
    title: 'switch文を使おう(1)：分岐する値',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceI5To8Models.switch1.correctProgram, 'switch (i)', 'switch (@[i]@)'),
  },
  sourceSwitch1BlankExitCase: {
    ...sourceI5To8Models.switch1,
    title: 'switch文を使おう(1)：分岐を抜ける命令',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI5To8Models.switch1.correctProgram,
      't.前に進む(); break;',
      't.前に進む(); @[break;]@'
    ),
  },
  sourceSwitch2BlankSelector: {
    ...sourceI5To8Models.switch2,
    title: 'switch文を使おう(2)：分岐する値',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceI5To8Models.switch2.correctProgram, 'switch (i % 4)', 'switch (@[i % 4]@)'),
  },
  sourceSwitch2BlankExitCase: {
    ...sourceI5To8Models.switch2,
    title: 'switch文を使おう(2)：分岐を抜ける命令',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI5To8Models.switch2.correctProgram,
      't.右を向く(); break;',
      't.右を向く(); @[break;]@'
    ),
  },
  sourceSwitch3BlankSelector: {
    ...sourceI5To8Models.switch3,
    title: 'switch文を使おう(3)：分岐する値',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceI5To8Models.switch3.correctProgram, 'switch (i)', 'switch (@[i]@)'),
  },
  sourceSwitch3BlankExitCase: {
    ...sourceI5To8Models.switch3,
    title: 'switch文を使おう(3)：分岐を抜ける命令',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI5To8Models.switch3.correctProgram,
      't.前に進む();\n                    break;',
      't.前に進む();\n                    @[break;]@'
    ),
  },
  sourceSwitch4BlankSelector: {
    ...sourceI5To8Models.switch4,
    title: 'switch文を使おう(4)：分岐する値',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceI5To8Models.switch4.correctProgram, 'switch (i % 5)', 'switch (@[i % 5]@)'),
  },
  sourceSwitch4BlankExitCase: {
    ...sourceI5To8Models.switch4,
    title: 'switch文を使おう(4)：分岐を抜ける命令',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI5To8Models.switch4.correctProgram,
      't.左を向く();\n                    break;',
      't.左を向く();\n                    @[break;]@'
    ),
  },
  sourceSwitch5BlankSelector: {
    ...sourceI5To8Models.switch5,
    title: 'switch文を使おう(5)：分岐する値',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceI5To8Models.switch5.correctProgram, 'switch (i % 6)', 'switch (@[i % 6]@)'),
  },
  sourceSwitch5BlankExitCase: {
    ...sourceI5To8Models.switch5,
    title: 'switch文を使おう(5)：分岐を抜ける命令',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI5To8Models.switch5.correctProgram,
      't.左を向く();\n                    break;',
      't.左を向く();\n                    @[break;]@'
    ),
  },
  sourceBreak1BlankStopPredicate: {
    ...sourceI5To8Models.break1,
    title: 'break文を使おう(1)：停止する条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI5To8Models.break1.correctProgram,
      '!t.前に進めるか()',
      '@[!t.前に進めるか()]@'
    ),
  },
  sourceBreak1BlankExitLoop: {
    ...sourceI5To8Models.break1,
    title: 'break文を使おう(1)：ループを抜ける命令',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceI5To8Models.break1.correctProgram, 'break;', '@[break;]@'),
  },
  sourceBreak2BlankFirstStopPredicate: {
    ...sourceI5To8Models.break2,
    title: 'break文を使おう(2)：最初の停止条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI5To8Models.break2.correctProgram,
      'if (!t.前に進めるか()) break;\n            t.前に進む();\n            t.右を向く();',
      'if (@[!t.前に進めるか()]@) break;\n            t.前に進む();\n            t.右を向く();'
    ),
  },
  sourceBreak2BlankSecondExitLoop: {
    ...sourceI5To8Models.break2,
    title: 'break文を使おう(2)：後半の停止命令',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI5To8Models.break2.correctProgram,
      'if (!t.前に進めるか()) break;\n            t.前に進む();\n            t.左を向く();',
      'if (!t.前に進めるか()) @[break;]@\n            t.前に進む();\n            t.左を向く();'
    ),
  },
  sourceBreak3BlankStopPredicate: {
    ...sourceI5To8Models.break3,
    title: 'break文を使おう(3)：停止する条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI5To8Models.break3.correctProgram,
      '!t.前に進めるか()',
      '@[!t.前に進めるか()]@'
    ),
  },
  sourceBreak3BlankExitLoop: {
    ...sourceI5To8Models.break3,
    title: 'break文を使おう(3)：内側のループを抜ける命令',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceI5To8Models.break3.correctProgram, 'break;', '@[break;]@'),
  },
  sourceBreak4BlankStopPredicate: {
    ...sourceI5To8Models.break4,
    title: 'break文を使おう(4)：停止する条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI5To8Models.break4.correctProgram,
      '!t.前に進めるか()',
      '@[!t.前に進めるか()]@'
    ),
  },
  sourceBreak4BlankExitLoop: {
    ...sourceI5To8Models.break4,
    title: 'break文を使おう(4)：内側のループを抜ける命令',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceI5To8Models.break4.correctProgram, 'break;', '@[break;]@'),
  },
  sourceBreak5BlankStopPredicate: {
    ...sourceI5To8Models.break5,
    title: 'break文を使おう(5)：停止する条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI5To8Models.break5.correctProgram,
      '!t.前に進めるか()',
      '@[!t.前に進めるか()]@'
    ),
  },
  sourceBreak5BlankExitLoop: {
    ...sourceI5To8Models.break5,
    title: 'break文を使おう(5)：内側のループを抜ける命令',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceI5To8Models.break5.correctProgram, 'break;', '@[break;]@'),
  },
  sourceContinue1BlankSkipPredicate: {
    ...sourceI5To8Models.continue1,
    title: 'continue文を使おう(1)：読み飛ばす条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceI5To8Models.continue1.correctProgram, 'i == 0', '@[i == 0]@'),
  },
  sourceContinue1BlankNextIteration: {
    ...sourceI5To8Models.continue1,
    title: 'continue文を使おう(1)：次の反復に進む命令',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceI5To8Models.continue1.correctProgram, 'continue;', '@[continue;]@'),
  },
  sourceContinue2BlankSkipPredicate: {
    ...sourceI5To8Models.continue2,
    title: 'continue文を使おう(2)：読み飛ばす条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceI5To8Models.continue2.correctProgram, 'i % 2 == 1', '@[i % 2 == 1]@'),
  },
  sourceContinue2BlankNextIteration: {
    ...sourceI5To8Models.continue2,
    title: 'continue文を使おう(2)：次の反復に進む命令',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceI5To8Models.continue2.correctProgram, 'continue;', '@[continue;]@'),
  },
  sourceContinue3BlankSkipPredicate: {
    ...sourceI5To8Models.continue3,
    title: 'continue文を使おう(3)：読み飛ばす条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceI5To8Models.continue3.correctProgram, 'j % 4 == 1', '@[j % 4 == 1]@'),
  },
  sourceContinue3BlankNextIteration: {
    ...sourceI5To8Models.continue3,
    title: 'continue文を使おう(3)：右折後の反復を進める命令',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI5To8Models.continue3.correctProgram,
      't.右を向く(); continue;',
      't.右を向く(); @[continue;]@'
    ),
  },
  sourceContinue4BlankSkipPredicate: {
    ...sourceI5To8Models.continue4,
    title: 'continue文を使おう(4)：読み飛ばす条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceI5To8Models.continue4.correctProgram, 'j % 2 == 0', '@[j % 2 == 0]@'),
  },
  sourceContinue4BlankNextIteration: {
    ...sourceI5To8Models.continue4,
    title: 'continue文を使おう(4)：次の反復に進む命令',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceI5To8Models.continue4.correctProgram, 'continue;', '@[continue;]@'),
  },
  sourceContinue5BlankSkipPredicate: {
    ...sourceI5To8Models.continue5,
    title: 'continue文を使おう(5)：読み飛ばす条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceI5To8Models.continue5.correctProgram, 'j % 4 == 0', '@[j % 4 == 0]@'),
  },
  sourceContinue5BlankNextIteration: {
    ...sourceI5To8Models.continue5,
    title: 'continue文を使おう(5)：左折後の反復を進める命令',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI5To8Models.continue5.correctProgram,
      't.左を向く(); continue;',
      't.左を向く(); @[continue;]@'
    ),
  },
  sourceMethod1BlankFirstCall: {
    ...sourceI5To8Models.method1,
    title: 'メソッドを使おう(1)：最初に呼び出すメソッド',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI5To8Models.method1.correctProgram,
      '二歩前に進める(t);',
      '@[二歩前に進める(t);]@'
    ),
  },
  sourceMethod1BlankSecondCall: {
    ...sourceI5To8Models.method1,
    title: 'メソッドを使おう(1)：右折後に呼び出すメソッド',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI5To8Models.method1.correctProgram,
      '三歩前に進める(t);',
      '@[三歩前に進める(t);]@'
    ),
  },
  sourceMethod2BlankAdvanceCall: {
    ...sourceI5To8Models.method2,
    title: 'メソッドを使おう(2)：前進するメソッドの呼び出し',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI5To8Models.method2.correctProgram,
      '二歩前に進める(t);',
      '@[二歩前に進める(t);]@'
    ),
  },
  sourceMethod2BlankTurnCall: {
    ...sourceI5To8Models.method2,
    title: 'メソッドを使おう(2)：方向転換するメソッドの呼び出し',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceI5To8Models.method2.correctProgram, '後ろを向く(t);', '@[後ろを向く(t);]@'),
  },
  sourceMethod3BlankArguments: {
    ...sourceI5To8Models.method3,
    title: 'メソッドを使おう(3)：最初の呼び出しの引数',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI5To8Models.method3.correctProgram,
      'N歩前に進める(t, 3);',
      'N歩前に進める(@[t, 3]@);'
    ),
  },
  sourceMethod3BlankParameterBound: {
    ...sourceI5To8Models.method3,
    title: 'メソッドを使おう(3)：仮引数を使う条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceI5To8Models.method3.correctProgram, 'i < n', '@[i < n]@'),
  },
  sourceMethod4BlankCompositeCall: {
    ...sourceI5To8Models.method4,
    title: 'メソッドを使おう(4)：四歩進むメソッドの呼び出し',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI5To8Models.method4.correctProgram,
      '四歩前に進める(t);',
      '@[四歩前に進める(t);]@'
    ),
  },
  sourceMethod4BlankNestedCall: {
    ...sourceI5To8Models.method4,
    title: 'メソッドを使おう(4)：メソッド内からの呼び出し',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI5To8Models.method4.correctProgram,
      'static void 四歩前に進める(Turtle t) {\n        二歩前に進める(t);',
      'static void 四歩前に進める(Turtle t) {\n        @[二歩前に進める(t);]@'
    ),
  },
  sourceMethod5BlankFirstCall: {
    ...sourceI5To8Models.method5,
    title: 'メソッドを使おう(5)：最初のメソッド呼び出し',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI5To8Models.method5.correctProgram,
      'Turtle t = new Turtle();\n        正方形を描く(t);',
      'Turtle t = new Turtle();\n        @[正方形を描く(t);]@'
    ),
  },
  sourceMethod5BlankHelperLoop: {
    ...sourceI5To8Models.method5,
    title: 'メソッドを使おう(5)：メソッド内の繰り返し条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceI5To8Models.method5.correctProgram, 'i < 3', '@[i < 3]@'),
  },
  sourceReturn1BlankReturnExpression: {
    ...sourceI5To8Models.return1,
    title: 'return文を使おう(1)：戻り値の式',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceI5To8Models.return1.correctProgram, 'return a * 2;', 'return @[a * 2]@;'),
  },
  sourceReturn1BlankReturnedArgument: {
    ...sourceI5To8Models.return1,
    title: 'return文を使おう(1)：戻り値を使う引数',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI5To8Models.return1.correctProgram,
      'N歩前に進める(t, x);',
      'N歩前に進める(@[t, x]@);'
    ),
  },
  sourceReturn2BlankReturnExpression: {
    ...sourceI5To8Models.return2,
    title: 'return文を使おう(2)：戻り値の式',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceI5To8Models.return2.correctProgram, 'return a * 2;', 'return @[a * 2]@;'),
  },
  sourceReturn2BlankReusedReturn: {
    ...sourceI5To8Models.return2,
    title: 'return文を使おう(2)：戻り値を再利用する呼び出し',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI5To8Models.return2.correctProgram,
      '二倍する(x - 1)',
      '@[二倍する(x - 1)]@'
    ),
  },
  sourceReturn3BlankReturnExpression: {
    ...sourceI5To8Models.return3,
    title: 'return文を使おう(3)：戻り値の式',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceI5To8Models.return3.correctProgram, 'return a + b;', 'return @[a + b]@;'),
  },
  sourceReturn3BlankNestedCall: {
    ...sourceI5To8Models.return3,
    title: 'return文を使おう(3)：引数になるメソッド呼び出し',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceI5To8Models.return3.correctProgram, '加算する(1, 2)', '@[加算する(1, 2)]@'),
  },
  sourceReturn4BlankReturnPredicate: {
    ...sourceI5To8Models.return4,
    title: 'return文を使おう(4)：真偽値を返す式',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI5To8Models.return4.correctProgram,
      'return a % 2 == 0;',
      'return @[a % 2 == 0]@;'
    ),
  },
  sourceReturn4BlankConditionCall: {
    ...sourceI5To8Models.return4,
    title: 'return文を使おう(4)：条件になるメソッド呼び出し',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceI5To8Models.return4.correctProgram, '偶数か(i)', '@[偶数か(i)]@'),
  },
  sourceReturn5BlankReturnPredicate: {
    ...sourceI5To8Models.return5,
    title: 'return文を使おう(5)：真偽値を返す式',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceI5To8Models.return5.correctProgram, 'return a == b;', 'return @[a == b]@;'),
  },
  sourceReturn5BlankConditionCall: {
    ...sourceI5To8Models.return5,
    title: 'return文を使おう(5)：条件になるメソッド呼び出し',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceI5To8Models.return5.correctProgram, '等しいか(i, j)', '@[等しいか(i, j)]@'),
  },
  sourceArray1BlankArrayBound: {
    ...sourceI5To8Models.array1,
    title: '配列を使おう(1)：配列を走査する条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceI5To8Models.array1.correctProgram, 'i < arr.length', '@[i < arr.length]@'),
  },
  sourceArray1BlankElementArgument: {
    ...sourceI5To8Models.array1,
    title: '配列を使おう(1)：配列の要素を渡す引数',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceI5To8Models.array1.correctProgram, 'arr[i]', '@[arr[i]]@'),
  },
  sourceArray2BlankArrayBound: {
    ...sourceI5To8Models.array2,
    title: '配列を使おう(2)：配列を走査する条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceI5To8Models.array2.correctProgram, 'i < arr.length', '@[i < arr.length]@'),
  },
  sourceArray2BlankElementArgument: {
    ...sourceI5To8Models.array2,
    title: '配列を使おう(2)：配列の要素を渡す引数',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceI5To8Models.array2.correctProgram, 'arr[i]', '@[arr[i]]@'),
  },
  sourceArray3BlankArrayBound: {
    ...sourceI5To8Models.array3,
    title: '配列を使おう(3)：配列を走査する条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceI5To8Models.array3.correctProgram, 'i < arr.length', '@[i < arr.length]@'),
  },
  sourceArray3BlankElementSelector: {
    ...sourceI5To8Models.array3,
    title: '配列を使おう(3)：配列の要素で分岐する式',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceI5To8Models.array3.correctProgram, 'arr[i]', '@[arr[i]]@'),
  },
  sourceArray4BlankIterationSource: {
    ...sourceI5To8Models.array4,
    title: '配列を使おう(4)：拡張for文で読む配列',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI5To8Models.array4.correctProgram,
      'for (int cmd : arr)',
      'for (int cmd : @[arr]@)'
    ),
  },
  sourceArray4BlankElementSelector: {
    ...sourceI5To8Models.array4,
    title: '配列を使おう(4)：取り出した要素で分岐する式',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceI5To8Models.array4.correctProgram, 'switch (cmd)', 'switch (@[cmd]@)'),
  },
  sourceArray5BlankIterationSource: {
    ...sourceI5To8Models.array5,
    title: '配列を使おう(5)：拡張for文で読む配列',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI5To8Models.array5.correctProgram,
      'for (int cmd : arr)',
      'for (int cmd : @[arr]@)'
    ),
  },
  sourceArray5BlankStepBound: {
    ...sourceI5To8Models.array5,
    title: '配列を使おう(5)：命令で変わる歩数の条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceI5To8Models.array5.correctProgram, 'i < steps', '@[i < steps]@'),
  },
  sourceString1BlankStringBound: {
    ...sourceI5To8Models.string1,
    title: '文字列を使おう(1)：文字列を走査する条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceI5To8Models.string1.correctProgram, 'i < s.length()', '@[i < s.length()]@'),
  },
  sourceString1BlankCharacterSelector: {
    ...sourceI5To8Models.string1,
    title: '文字列を使おう(1)：位置から文字を取り出す式',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceI5To8Models.string1.correctProgram, 's.charAt(i)', '@[s.charAt(i)]@'),
  },
  sourceString2BlankStringBound: {
    ...sourceI5To8Models.string2,
    title: '文字列を使おう(2)：文字列を走査する条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceI5To8Models.string2.correctProgram, 'i < s.length()', '@[i < s.length()]@'),
  },
  sourceString2BlankCharacterSelector: {
    ...sourceI5To8Models.string2,
    title: '文字列を使おう(2)：位置から文字を取り出す式',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceI5To8Models.string2.correctProgram, 's.charAt(i)', '@[s.charAt(i)]@'),
  },
  sourceString3BlankCharacterArray: {
    ...sourceI5To8Models.string3,
    title: '文字列を使おう(3)：文字配列に変換する式',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI5To8Models.string3.correctProgram,
      's.toCharArray()',
      '@[s.toCharArray()]@'
    ),
  },
  sourceString3BlankCharacterSelector: {
    ...sourceI5To8Models.string3,
    title: '文字列を使おう(3)：取り出した文字で分岐する式',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceI5To8Models.string3.correctProgram, 'switch (ch)', 'switch (@[ch]@)'),
  },
  sourceString4BlankForwardPredicate: {
    ...sourceI5To8Models.string4,
    title: '文字列を使おう(4)：前進命令を比較する式',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceI5To8Models.string4.correctProgram, 'c.equals("fo")', '@[c.equals("fo")]@'),
  },
  sourceString4BlankTurnPredicate: {
    ...sourceI5To8Models.string4,
    title: '文字列を使おう(4)：右折命令を比較する式',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceI5To8Models.string4.correctProgram, 'c.equals("ri")', '@[c.equals("ri")]@'),
  },
  sourceString5BlankIncrementPredicate: {
    ...sourceI5To8Models.string5,
    title: '文字列を使おう(5)：歩数を増やす命令の比較',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI5To8Models.string5.correctProgram,
      'cmd.equals("add")',
      '@[cmd.equals("add")]@'
    ),
  },
  sourceString5BlankForwardArguments: {
    ...sourceI5To8Models.string5,
    title: '文字列を使おう(5)：文字列命令から歩数を渡す引数',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI5To8Models.string5.correctProgram,
      'N歩前に進める(t, x);',
      'N歩前に進める(@[t, x]@);'
    ),
  },
} satisfies Record<string, JavaChallengeDefinition>;
