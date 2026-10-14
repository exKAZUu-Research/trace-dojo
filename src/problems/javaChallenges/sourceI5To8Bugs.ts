import { sourceI5To8Models } from './sourceI5To8Models';
import { replaceSourceOnce } from './sourceModels';
import type { JavaChallengeDefinition } from './types';

export const sourceI5To8Bugs = {
  sourceElseIf1BugInclusiveFirstBranch: {
    ...sourceI5To8Models.elseIf1,
    title: sourceI5To8Models.elseIf1.title + '：分岐の境界を直す',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(sourceI5To8Models.elseIf1.correctProgram, 'i < 2', 'i <= 2'),
  },
  sourceElseIf1BugIntegerCondition: {
    ...sourceI5To8Models.elseIf1,
    title: sourceI5To8Models.elseIf1.title + '：else ifの条件式を直す',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(sourceI5To8Models.elseIf1.correctProgram, 'i == 2', 'i'),
  },
  sourceElseIf2BugFinalTurn: {
    ...sourceI5To8Models.elseIf2,
    title: sourceI5To8Models.elseIf2.title + '：最後の分岐の向きを直す',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(sourceI5To8Models.elseIf2.correctProgram, 't.左を向く();', 't.右を向く();'),
  },
  sourceElseIf2BugIntegerCondition: {
    ...sourceI5To8Models.elseIf2,
    title: sourceI5To8Models.elseIf2.title + '：else ifの条件式を直す',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(sourceI5To8Models.elseIf2.correctProgram, 'i % 4 == 1', 'i % 4'),
  },
  sourceElseIf3BugRepeatedTurnBranch: {
    ...sourceI5To8Models.elseIf3,
    title: sourceI5To8Models.elseIf3.title + '：分岐が選ばれる条件を直す',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(sourceI5To8Models.elseIf3.correctProgram, 'i == 4', 'i >= 4'),
  },
  sourceElseIf3BugIntegerCondition: {
    ...sourceI5To8Models.elseIf3,
    title: sourceI5To8Models.elseIf3.title + '：else ifの条件式を直す',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(sourceI5To8Models.elseIf3.correctProgram, 'i == 4', 'i'),
  },
  sourceElseIf4BugBroadBackwardBranch: {
    ...sourceI5To8Models.elseIf4,
    title: sourceI5To8Models.elseIf4.title + '：後退を選ぶ条件を直す',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(sourceI5To8Models.elseIf4.correctProgram, 'i % 5 == 2', 'i % 5 >= 2'),
  },
  sourceElseIf4BugIntegerCondition: {
    ...sourceI5To8Models.elseIf4,
    title: sourceI5To8Models.elseIf4.title + '：else ifの条件式を直す',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(sourceI5To8Models.elseIf4.correctProgram, 'i % 5 == 1', 'i % 5'),
  },
  sourceElseIf5BugTurnRemainder: {
    ...sourceI5To8Models.elseIf5,
    title: sourceI5To8Models.elseIf5.title + '：右折を選ぶ条件を直す',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(sourceI5To8Models.elseIf5.correctProgram, 'i % 5 == 1', 'i % 5 == 0'),
  },
  sourceElseIf5BugIntegerCondition: {
    ...sourceI5To8Models.elseIf5,
    title: sourceI5To8Models.elseIf5.title + '：else ifの条件式を直す',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(sourceI5To8Models.elseIf5.correctProgram, 'i % 5 == 3', 'i % 5'),
  },
  sourceSwitch1BugDefaultAction: {
    ...sourceI5To8Models.switch1,
    title: sourceI5To8Models.switch1.title + '：default節の動きを直す',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI5To8Models.switch1.correctProgram,
      't.後に戻る(); break;',
      't.右を向く(); break;'
    ),
  },
  sourceSwitch1BugNonconstantCase: {
    ...sourceI5To8Models.switch1,
    title: sourceI5To8Models.switch1.title + '：caseラベルを直す',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(sourceI5To8Models.switch1.correctProgram, 'case 1:', 'case i:'),
  },
  sourceSwitch2BugCaseFallthrough: {
    ...sourceI5To8Models.switch2,
    title: sourceI5To8Models.switch2.title + '：caseの処理範囲を直す',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI5To8Models.switch2.correctProgram,
      't.左を向く(); break;',
      't.左を向く();'
    ),
  },
  sourceSwitch2BugNonconstantCase: {
    ...sourceI5To8Models.switch2,
    title: sourceI5To8Models.switch2.title + '：caseラベルを直す',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(sourceI5To8Models.switch2.correctProgram, 'case 1:', 'case i:'),
  },
  sourceSwitch3BugCaseFallthrough: {
    ...sourceI5To8Models.switch3,
    title: sourceI5To8Models.switch3.title + '：caseの処理範囲を直す',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI5To8Models.switch3.correctProgram,
      't.左を向く();\n                    break;',
      't.左を向く();'
    ),
  },
  sourceSwitch3BugNonconstantCase: {
    ...sourceI5To8Models.switch3,
    title: sourceI5To8Models.switch3.title + '：caseラベルを直す',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(sourceI5To8Models.switch3.correctProgram, 'case 1:', 'case i:'),
  },
  sourceSwitch4BugCyclicSelector: {
    ...sourceI5To8Models.switch4,
    title: sourceI5To8Models.switch4.title + '：周期的な分岐を直す',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(sourceI5To8Models.switch4.correctProgram, 'switch (i % 5)', 'switch (i)'),
  },
  sourceSwitch4BugNonconstantCase: {
    ...sourceI5To8Models.switch4,
    title: sourceI5To8Models.switch4.title + '：caseラベルを直す',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(sourceI5To8Models.switch4.correctProgram, 'case 1:', 'case i:'),
  },
  sourceSwitch5BugCyclicSelector: {
    ...sourceI5To8Models.switch5,
    title: sourceI5To8Models.switch5.title + '：周期的な分岐を直す',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(sourceI5To8Models.switch5.correctProgram, 'switch (i % 6)', 'switch (i)'),
  },
  sourceSwitch5BugNonconstantCase: {
    ...sourceI5To8Models.switch5,
    title: sourceI5To8Models.switch5.title + '：caseラベルを直す',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(sourceI5To8Models.switch5.correctProgram, 'case 1:', 'case i:'),
  },
  sourceBreak1BugReversedStop: {
    ...sourceI5To8Models.break1,
    title: sourceI5To8Models.break1.title + '：停止条件を直す',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(sourceI5To8Models.break1.correctProgram, '!t.前に進めるか()', 't.前に進めるか()'),
  },
  sourceBreak1BugLoopConditionType: {
    ...sourceI5To8Models.break1,
    title: sourceI5To8Models.break1.title + '：whileの条件の型を直す',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(sourceI5To8Models.break1.correctProgram, 'while (true)', 'while (1)'),
  },
  sourceBreak2BugFirstStop: {
    ...sourceI5To8Models.break2,
    title: sourceI5To8Models.break2.title + '：最初の停止条件を直す',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI5To8Models.break2.correctProgram,
      'if (!t.前に進めるか()) break;\n            t.前に進む();\n            t.右を向く();',
      'if (t.前に進めるか()) break;\n            t.前に進む();\n            t.右を向く();'
    ),
  },
  sourceBreak2BugLoopConditionType: {
    ...sourceI5To8Models.break2,
    title: sourceI5To8Models.break2.title + '：whileの条件の型を直す',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(sourceI5To8Models.break2.correctProgram, 'while (true)', 'while (1)'),
  },
  sourceBreak3BugNextEdge: {
    ...sourceI5To8Models.break3,
    title: sourceI5To8Models.break3.title + '：次に進む辺の向きを直す',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(sourceI5To8Models.break3.correctProgram, 't.右を向く();', 't.左を向く();'),
  },
  sourceBreak3BugForConditionType: {
    ...sourceI5To8Models.break3,
    title: sourceI5To8Models.break3.title + '：forの条件の型を直す',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(sourceI5To8Models.break3.correctProgram, 'i < 4', 'i'),
  },
  sourceBreak4BugReversedStop: {
    ...sourceI5To8Models.break4,
    title: sourceI5To8Models.break4.title + '：内側の停止条件を直す',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(sourceI5To8Models.break4.correctProgram, '!t.前に進めるか()', 't.前に進めるか()'),
  },
  sourceBreak4BugLoopConditionType: {
    ...sourceI5To8Models.break4,
    title: sourceI5To8Models.break4.title + '：whileの条件の型を直す',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(sourceI5To8Models.break4.correctProgram, 'while (true)', 'while (1)'),
  },
  sourceBreak5BugReversedStop: {
    ...sourceI5To8Models.break5,
    title: sourceI5To8Models.break5.title + '：内側の停止条件を直す',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(sourceI5To8Models.break5.correctProgram, '!t.前に進めるか()', 't.前に進めるか()'),
  },
  sourceBreak5BugForConditionType: {
    ...sourceI5To8Models.break5,
    title: sourceI5To8Models.break5.title + '：forの条件の型を直す',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(sourceI5To8Models.break5.correctProgram, 'i < 3', 'i'),
  },
  sourceContinue1BugPrematureExit: {
    ...sourceI5To8Models.continue1,
    title: sourceI5To8Models.continue1.title + '：反復を続ける処理を直す',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(sourceI5To8Models.continue1.correctProgram, 'continue;', 'break;'),
  },
  sourceContinue1BugSkipConditionType: {
    ...sourceI5To8Models.continue1,
    title: sourceI5To8Models.continue1.title + '：continueを選ぶ条件を直す',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(sourceI5To8Models.continue1.correctProgram, 'i == 0', 'i'),
  },
  sourceContinue2BugPrematureExit: {
    ...sourceI5To8Models.continue2,
    title: sourceI5To8Models.continue2.title + '：反復を続ける処理を直す',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(sourceI5To8Models.continue2.correctProgram, 'continue;', 'break;'),
  },
  sourceContinue2BugSkipConditionType: {
    ...sourceI5To8Models.continue2,
    title: sourceI5To8Models.continue2.title + '：continueを選ぶ条件を直す',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(sourceI5To8Models.continue2.correctProgram, 'i % 2 == 1', 'i % 2'),
  },
  sourceContinue4BugPrematureExit: {
    ...sourceI5To8Models.continue4,
    title: sourceI5To8Models.continue4.title + '：反復を続ける処理を直す',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(sourceI5To8Models.continue4.correctProgram, 'continue;', 'break;'),
  },
  sourceContinue4BugSkipConditionType: {
    ...sourceI5To8Models.continue4,
    title: sourceI5To8Models.continue4.title + '：continueを選ぶ条件を直す',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(sourceI5To8Models.continue4.correctProgram, 'j % 2 == 0', 'j % 2'),
  },
  sourceContinue3BugPrematureExit: {
    ...sourceI5To8Models.continue3,
    title: sourceI5To8Models.continue3.title + '：右折後の反復を直す',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI5To8Models.continue3.correctProgram,
      't.右を向く(); continue;',
      't.右を向く(); break;'
    ),
  },
  sourceContinue3BugSkipConditionType: {
    ...sourceI5To8Models.continue3,
    title: sourceI5To8Models.continue3.title + '：continueを選ぶ条件を直す',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(sourceI5To8Models.continue3.correctProgram, 'j % 4 == 1', 'j % 4'),
  },
  sourceContinue5BugPrematureExit: {
    ...sourceI5To8Models.continue5,
    title: sourceI5To8Models.continue5.title + '：左折後の反復を直す',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI5To8Models.continue5.correctProgram,
      't.左を向く(); continue;',
      't.左を向く(); break;'
    ),
  },
  sourceContinue5BugSkipConditionType: {
    ...sourceI5To8Models.continue5,
    title: sourceI5To8Models.continue5.title + '：continueを選ぶ条件を直す',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(sourceI5To8Models.continue5.correctProgram, 'j % 4 == 0', 'j % 4'),
  },
  sourceMethod1BugWrongHelper: {
    ...sourceI5To8Models.method1,
    title: sourceI5To8Models.method1.title + '：呼び出すメソッドを直す',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI5To8Models.method1.correctProgram,
      '三歩前に進める(t);',
      '二歩前に進める(t);'
    ),
  },
  sourceMethod1BugMissingArgument: {
    ...sourceI5To8Models.method1,
    title: sourceI5To8Models.method1.title + '：メソッドに渡す引数を直す',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceI5To8Models.method1.correctProgram,
      '三歩前に進める(t);',
      '三歩前に進める();'
    ),
  },
  sourceMethod2BugWrongHelper: {
    ...sourceI5To8Models.method2,
    title: sourceI5To8Models.method2.title + '：方向転換の呼び出しを直す',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(sourceI5To8Models.method2.correctProgram, '後ろを向く(t);', '二歩前に進める(t);'),
  },
  sourceMethod2BugMissingArgument: {
    ...sourceI5To8Models.method2,
    title: sourceI5To8Models.method2.title + '：メソッドに渡す引数を直す',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(sourceI5To8Models.method2.correctProgram, '後ろを向く(t);', '後ろを向く();'),
  },
  sourceMethod3BugParameterBound: {
    ...sourceI5To8Models.method3,
    title: sourceI5To8Models.method3.title + '：仮引数と繰り返し条件を直す',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(sourceI5To8Models.method3.correctProgram, 'i < n', 'i <= n'),
  },
  sourceMethod3BugArgumentOrder: {
    ...sourceI5To8Models.method3,
    title: sourceI5To8Models.method3.title + '：メソッドの引数順を直す',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceI5To8Models.method3.correctProgram,
      'N歩前に進める(t, 3);',
      'N歩前に進める(3, t);'
    ),
  },
  sourceMethod4BugWrongHelper: {
    ...sourceI5To8Models.method4,
    title: sourceI5To8Models.method4.title + '：組み合わせたメソッドの呼び出しを直す',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI5To8Models.method4.correctProgram,
      '四歩前に進める(t);',
      '二歩前に進める(t);'
    ),
  },
  sourceMethod4BugMissingArgument: {
    ...sourceI5To8Models.method4,
    title: sourceI5To8Models.method4.title + '：メソッドに渡す引数を直す',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceI5To8Models.method4.correctProgram,
      '四歩前に進める(t);',
      '四歩前に進める();'
    ),
  },
  sourceMethod5BugOmittedInvocation: {
    ...sourceI5To8Models.method5,
    title: sourceI5To8Models.method5.title + '：二度目の描画を直す',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI5To8Models.method5.correctProgram,
      't.後に戻る();\n        正方形を描く(t);',
      't.後に戻る();'
    ),
  },
  sourceMethod5BugParameterType: {
    ...sourceI5To8Models.method5,
    title: sourceI5To8Models.method5.title + '：メソッドの仮引数の型を直す',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceI5To8Models.method5.correctProgram,
      'static void 正方形を描く(Turtle t)',
      'static void 正方形を描く(int t)'
    ),
  },
  sourceReturn1BugReturnArithmetic: {
    ...sourceI5To8Models.return1,
    title: sourceI5To8Models.return1.title + '：戻り値の計算を直す',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(sourceI5To8Models.return1.correctProgram, 'return a * 2;', 'return a / 2;'),
  },
  sourceReturn1BugReturnType: {
    ...sourceI5To8Models.return1,
    title: sourceI5To8Models.return1.title + '：戻り値の型を直す',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceI5To8Models.return1.correctProgram,
      'static int 二倍する(int a)',
      'static boolean 二倍する(int a)'
    ),
  },
  sourceReturn2BugReturnArithmetic: {
    ...sourceI5To8Models.return2,
    title: sourceI5To8Models.return2.title + '：戻り値の計算を直す',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(sourceI5To8Models.return2.correctProgram, 'return a * 2;', 'return a / 2;'),
  },
  sourceReturn2BugReturnType: {
    ...sourceI5To8Models.return2,
    title: sourceI5To8Models.return2.title + '：戻り値の型を直す',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceI5To8Models.return2.correctProgram,
      'static int 二倍する(int a)',
      'static boolean 二倍する(int a)'
    ),
  },
  sourceReturn3BugReturnArithmetic: {
    ...sourceI5To8Models.return3,
    title: sourceI5To8Models.return3.title + '：戻り値の計算を直す',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(sourceI5To8Models.return3.correctProgram, 'return a + b;', 'return a - b;'),
  },
  sourceReturn3BugMissingReturnValue: {
    ...sourceI5To8Models.return3,
    title: sourceI5To8Models.return3.title + '：returnで返す値を直す',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(sourceI5To8Models.return3.correctProgram, 'return a + b;', 'return;'),
  },
  sourceReturn4BugRestrictedPredicate: {
    ...sourceI5To8Models.return4,
    title: sourceI5To8Models.return4.title + '：戻り値の条件を直す',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI5To8Models.return4.correctProgram,
      'return a % 2 == 0;',
      'return a % 2 == 0 && a < 2;'
    ),
  },
  sourceReturn4BugReturnType: {
    ...sourceI5To8Models.return4,
    title: sourceI5To8Models.return4.title + '：戻り値の型を直す',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceI5To8Models.return4.correctProgram,
      'static boolean 偶数か(int a)',
      'static int 偶数か(int a)'
    ),
  },
  sourceReturn5BugBroadPredicate: {
    ...sourceI5To8Models.return5,
    title: sourceI5To8Models.return5.title + '：戻り値の条件を直す',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI5To8Models.return5.correctProgram,
      'return a == b;',
      'return a == b || a == 2;'
    ),
  },
  sourceReturn5BugReturnType: {
    ...sourceI5To8Models.return5,
    title: sourceI5To8Models.return5.title + '：戻り値の型を直す',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceI5To8Models.return5.correctProgram,
      'static boolean 等しいか(int a, int b)',
      'static int 等しいか(int a, int b)'
    ),
  },
  sourceArray1BugLastElementSkipped: {
    ...sourceI5To8Models.array1,
    title: sourceI5To8Models.array1.title + '：配列の走査範囲を直す',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(sourceI5To8Models.array1.correctProgram, 'i < arr.length', 'i < arr.length - 1'),
  },
  sourceArray1BugArrayLengthCall: {
    ...sourceI5To8Models.array1,
    title: sourceI5To8Models.array1.title + '：配列の長さの参照を直す',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(sourceI5To8Models.array1.correctProgram, 'arr.length', 'arr.length()'),
  },
  sourceArray2BugLastElementSkipped: {
    ...sourceI5To8Models.array2,
    title: sourceI5To8Models.array2.title + '：配列の走査範囲を直す',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(sourceI5To8Models.array2.correctProgram, 'i < arr.length', 'i < arr.length - 1'),
  },
  sourceArray2BugArrayLengthCall: {
    ...sourceI5To8Models.array2,
    title: sourceI5To8Models.array2.title + '：配列の長さの参照を直す',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(sourceI5To8Models.array2.correctProgram, 'arr.length', 'arr.length()'),
  },
  sourceArray3BugIndexInsteadOfElement: {
    ...sourceI5To8Models.array3,
    title: sourceI5To8Models.array3.title + '：配列から読む値を直す',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(sourceI5To8Models.array3.correctProgram, 'switch (arr[i])', 'switch (i)'),
  },
  sourceArray3BugArrayLengthCall: {
    ...sourceI5To8Models.array3,
    title: sourceI5To8Models.array3.title + '：配列の長さの参照を直す',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(sourceI5To8Models.array3.correctProgram, 'arr.length', 'arr.length()'),
  },
  sourceArray4BugValueAsIndex: {
    ...sourceI5To8Models.array4,
    title: sourceI5To8Models.array4.title + '：取り出した配列要素の使い方を直す',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(sourceI5To8Models.array4.correctProgram, 'switch (cmd)', 'switch (arr[cmd])'),
  },
  sourceArray4BugEnhancedForSource: {
    ...sourceI5To8Models.array4,
    title: sourceI5To8Models.array4.title + '：拡張for文の対象を直す',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceI5To8Models.array4.correctProgram,
      'for (int cmd : arr)',
      'for (int cmd : arr.length)'
    ),
  },
  sourceArray5BugStepUpdate: {
    ...sourceI5To8Models.array5,
    title: sourceI5To8Models.array5.title + '：配列命令での歩数更新を直す',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(sourceI5To8Models.array5.correctProgram, 'steps++;', 'steps--;'),
  },
  sourceArray5BugEnhancedForSource: {
    ...sourceI5To8Models.array5,
    title: sourceI5To8Models.array5.title + '：拡張for文の対象を直す',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceI5To8Models.array5.correctProgram,
      'for (int cmd : arr)',
      'for (int cmd : arr.length)'
    ),
  },
  sourceString1BugLastCharacterSkipped: {
    ...sourceI5To8Models.string1,
    title: sourceI5To8Models.string1.title + '：文字列の走査範囲を直す',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(sourceI5To8Models.string1.correctProgram, 'i < s.length()', 'i < s.length() - 1'),
  },
  sourceString1BugStringLengthField: {
    ...sourceI5To8Models.string1,
    title: sourceI5To8Models.string1.title + '：文字列の長さの参照を直す',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(sourceI5To8Models.string1.correctProgram, 's.length()', 's.length'),
  },
  sourceString2BugLastCharacterSkipped: {
    ...sourceI5To8Models.string2,
    title: sourceI5To8Models.string2.title + '：文字列の走査範囲を直す',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(sourceI5To8Models.string2.correctProgram, 'i < s.length()', 'i < s.length() - 1'),
  },
  sourceString2BugStringLengthField: {
    ...sourceI5To8Models.string2,
    title: sourceI5To8Models.string2.title + '：文字列の長さの参照を直す',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(sourceI5To8Models.string2.correctProgram, 's.length()', 's.length'),
  },
  sourceString3BugRepeatedFirstCharacter: {
    ...sourceI5To8Models.string3,
    title: sourceI5To8Models.string3.title + '：取り出した文字の使い方を直す',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(sourceI5To8Models.string3.correctProgram, 'switch (ch)', 'switch (s.charAt(0))'),
  },
  sourceString3BugEnhancedForString: {
    ...sourceI5To8Models.string3,
    title: sourceI5To8Models.string3.title + '：文字を取り出す拡張for文を直す',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(sourceI5To8Models.string3.correctProgram, 's.toCharArray()', 's'),
  },
  sourceString4BugNegatedComparison: {
    ...sourceI5To8Models.string4,
    title: sourceI5To8Models.string4.title + '：文字列の比較条件を直す',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(sourceI5To8Models.string4.correctProgram, 'c.equals("fo")', '!c.equals("fo")'),
  },
  sourceString4BugComparisonType: {
    ...sourceI5To8Models.string4,
    title: sourceI5To8Models.string4.title + '：文字列比較の戻り値を直す',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(sourceI5To8Models.string4.correctProgram, 'c.equals("fo")', 'c.compareTo("fo")'),
  },
  sourceString5BugCommandArgument: {
    ...sourceI5To8Models.string5,
    title: sourceI5To8Models.string5.title + '：命令に渡す歩数を直す',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI5To8Models.string5.correctProgram,
      'parse(t, cmd, x);',
      'parse(t, cmd, x + 1);'
    ),
  },
  sourceString5BugComparisonType: {
    ...sourceI5To8Models.string5,
    title: sourceI5To8Models.string5.title + '：文字列比較の戻り値を直す',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceI5To8Models.string5.correctProgram,
      'cmd.equals("add")',
      'cmd.compareTo("add")'
    ),
  },
} satisfies Record<string, JavaChallengeDefinition>;
