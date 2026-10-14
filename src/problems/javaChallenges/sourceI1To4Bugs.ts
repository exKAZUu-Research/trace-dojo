import { sourceI1To4Models } from './sourceI1To4Models';
import { replaceSourceOnce } from './sourceModels';
import type { JavaChallengeDefinition } from './types';

export const sourceI1To4Bugs = {
  sourceStraightBugFirstTurn: {
    ...sourceI1To4Models.straight,
    title: '線を描こう(1)：最初の命令の種類',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.straight.correctProgram,
      '        Turtle 亀 = new Turtle();\n        亀.前に進む();\n        亀.前に進む();',
      '        Turtle 亀 = new Turtle();\n        亀.右を向く();\n        亀.前に進む();'
    ),
  },
  sourceStraightBugLastTurn: {
    ...sourceI1To4Models.straight,
    title: '線を描こう(1)：最後の命令の種類',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.straight.correctProgram,
      '        亀.前に進む();\n        亀.前に進む();\n    }',
      '        亀.前に進む();\n        亀.左を向く();\n    }'
    ),
  },
  sourceStraight2BugFirstTurn: {
    ...sourceI1To4Models.straight2,
    title: '線を描こう(2)：最初の命令の種類',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.straight2.correctProgram,
      '        Turtle 亀 = new Turtle();\n        亀.前に進む();\n        亀.前に進む();',
      '        Turtle 亀 = new Turtle();\n        亀.右を向く();\n        亀.前に進む();'
    ),
  },
  sourceStraight2BugLastBacktrack: {
    ...sourceI1To4Models.straight2,
    title: '線を描こう(2)：最後の進行方向',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.straight2.correctProgram,
      '        亀.前に進む();\n        亀.前に進む();\n    }',
      '        亀.前に進む();\n        亀.後に戻る();\n    }'
    ),
  },
  sourceStepBackBugReturnDirection: {
    ...sourceI1To4Models.stepBack,
    title: '線を描こう(3)：戻るときの進行方向',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.stepBack.correctProgram,
      '        亀.後に戻る();',
      '        亀.前に進む();'
    ),
  },
  sourceStepBackBugReturnTurn: {
    ...sourceI1To4Models.stepBack,
    title: '線を描こう(3)：戻る命令の種類',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.stepBack.correctProgram,
      '        亀.後に戻る();',
      '        亀.右を向く();'
    ),
  },
  sourceStepBack2BugMiddleDirection: {
    ...sourceI1To4Models.stepBack2,
    title: '線を描こう(4)：途中の進行方向',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.stepBack2.correctProgram,
      '        亀.後に戻る();',
      '        亀.前に進む();'
    ),
  },
  sourceStepBack2BugLastDirection: {
    ...sourceI1To4Models.stepBack2,
    title: '線を描こう(4)：最後の進行方向',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.stepBack2.correctProgram,
      '        亀.前に進む();\n        亀.前に進む();\n    }',
      '        亀.前に進む();\n        亀.後に戻る();\n    }'
    ),
  },
  sourceTurnRightBugTurnOrAdvance: {
    ...sourceI1To4Models.turnRight,
    title: '線を描こう(5)：旋回と移動',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.turnRight.correctProgram,
      '        亀.右を向く();',
      '        亀.前に進む();'
    ),
  },
  sourceTurnRightBugLastTurn: {
    ...sourceI1To4Models.turnRight,
    title: '線を描こう(5)：旋回後の命令',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.turnRight.correctProgram,
      '        亀.右を向く();\n        亀.前に進む();\n    }',
      '        亀.右を向く();\n        亀.右を向く();\n    }'
    ),
  },
  sourceTurnRight2BugTurnSequence: {
    ...sourceI1To4Models.turnRight2,
    title: '線を描こう(6)：旋回命令の実行順序',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.turnRight2.correctProgram,
      '        亀.前に進む();\n        亀.右を向く();',
      '        亀.右を向く();\n        亀.前に進む();'
    ),
  },
  sourceTurnRight2BugLastDirection: {
    ...sourceI1To4Models.turnRight2,
    title: '線を描こう(6)：最後の進行方向',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.turnRight2.correctProgram,
      '        亀.前に進む();\n        亀.前に進む();\n    }',
      '        亀.前に進む();\n        亀.後に戻る();\n    }'
    ),
  },
  sourceTurnLeftAndRightBugMiddleOperation: {
    ...sourceI1To4Models.turnLeftAndRight,
    title: '線を描こう(7)：途中の命令の種類',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.turnLeftAndRight.correctProgram,
      '        亀.左を向く();',
      '        亀.前に進む();'
    ),
  },
  sourceTurnLeftAndRightBugLastDirection: {
    ...sourceI1To4Models.turnLeftAndRight,
    title: '線を描こう(7)：最後の進行方向',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.turnLeftAndRight.correctProgram,
      '        亀.左を向く();\n        亀.前に進む();\n    }',
      '        亀.左を向く();\n        亀.右を向く();\n    }'
    ),
  },
  sourceTurnLeftAndRight2BugMiddleTurn: {
    ...sourceI1To4Models.turnLeftAndRight2,
    title: '線を描こう(8)：途中の旋回方向',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.turnLeftAndRight2.correctProgram,
      '        亀.左を向く();',
      '        亀.右を向く();'
    ),
  },
  sourceTurnLeftAndRight2BugLastDirection: {
    ...sourceI1To4Models.turnLeftAndRight2,
    title: '線を描こう(8)：最後の進行方向',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.turnLeftAndRight2.correctProgram,
      '        亀.左を向く();\n        亀.前に進む();\n    }',
      '        亀.左を向く();\n        亀.後に戻る();\n    }'
    ),
  },
  sourceTurnLeftAndRight3BugLastTurn: {
    ...sourceI1To4Models.turnLeftAndRight3,
    title: '線を描こう(9)：最後の旋回方向',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.turnLeftAndRight3.correctProgram,
      '        亀.前に進む();\n        亀.右を向く();\n        亀.前に進む();',
      '        亀.前に進む();\n        亀.左を向く();\n        亀.前に進む();'
    ),
  },
  sourceTurnLeftAndRight3BugLastDirection: {
    ...sourceI1To4Models.turnLeftAndRight3,
    title: '線を描こう(9)：最後の進行方向',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.turnLeftAndRight3.correctProgram,
      '        亀.右を向く();\n        亀.前に進む();\n    }',
      '        亀.右を向く();\n        亀.後に戻る();\n    }'
    ),
  },
  sourceTurnLeftAndRight4BugMiddleTurn: {
    ...sourceI1To4Models.turnLeftAndRight4,
    title: '線を描こう(10)：途中の旋回方向',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.turnLeftAndRight4.correctProgram,
      '        亀.左を向く();',
      '        亀.右を向く();'
    ),
  },
  sourceTurnLeftAndRight4BugLastDirection: {
    ...sourceI1To4Models.turnLeftAndRight4,
    title: '線を描こう(10)：最後の進行方向',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.turnLeftAndRight4.correctProgram,
      '        亀.前に進む();\n        亀.前に進む();\n    }',
      '        亀.前に進む();\n        亀.後に戻る();\n    }'
    ),
  },
  sourceSquare1BugLastTurn: {
    ...sourceI1To4Models.square1,
    title: '図形を描こう(1)：最後の旋回方向',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.square1.correctProgram,
      '        亀.右を向く();\n        亀.前に進む();\n        亀.右を向く();\n        亀.前に進む();\n    }',
      '        亀.右を向く();\n        亀.前に進む();\n        亀.左を向く();\n        亀.前に進む();\n    }'
    ),
  },
  sourceSquare1BugLastDirection: {
    ...sourceI1To4Models.square1,
    title: '図形を描こう(1)：最後の進行方向',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.square1.correctProgram,
      '        亀.右を向く();\n        亀.前に進む();\n    }',
      '        亀.右を向く();\n        亀.後に戻る();\n    }'
    ),
  },
  sourceSquare2BugLastTurn: {
    ...sourceI1To4Models.square2,
    title: '図形を描こう(2)：最後の旋回方向',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.square2.correctProgram,
      '        亀.右を向く();\n        亀.前に進む();\n        亀.右を向く();\n        亀.前に進む();\n    }',
      '        亀.右を向く();\n        亀.前に進む();\n        亀.左を向く();\n        亀.前に進む();\n    }'
    ),
  },
  sourceSquare2BugLastDirection: {
    ...sourceI1To4Models.square2,
    title: '図形を描こう(2)：最後の進行方向',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.square2.correctProgram,
      '        亀.右を向く();\n        亀.前に進む();\n    }',
      '        亀.右を向く();\n        亀.後に戻る();\n    }'
    ),
  },
  sourceSquare3BugLastTurn: {
    ...sourceI1To4Models.square3,
    title: '図形を描こう(3)：最後の旋回方向',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.square3.correctProgram,
      '        亀.左を向く();\n        亀.前に進む();\n        亀.左を向く();\n        亀.前に進む();\n    }',
      '        亀.左を向く();\n        亀.前に進む();\n        亀.右を向く();\n        亀.前に進む();\n    }'
    ),
  },
  sourceSquare3BugLastDirection: {
    ...sourceI1To4Models.square3,
    title: '図形を描こう(3)：最後の進行方向',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.square3.correctProgram,
      '        亀.左を向く();\n        亀.前に進む();\n    }',
      '        亀.左を向く();\n        亀.後に戻る();\n    }'
    ),
  },
  sourceSquare4BugLastTurn: {
    ...sourceI1To4Models.square4,
    title: '図形を描こう(4)：最後の旋回方向',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.square4.correctProgram,
      '        亀.右を向く();\n        亀.前に進む();\n        亀.前に進む();\n        亀.右を向く();\n        亀.前に進む();\n        亀.前に進む();\n    }',
      '        亀.右を向く();\n        亀.前に進む();\n        亀.前に進む();\n        亀.左を向く();\n        亀.前に進む();\n        亀.前に進む();\n    }'
    ),
  },
  sourceSquare4BugLastDirection: {
    ...sourceI1To4Models.square4,
    title: '図形を描こう(4)：最後の進行方向',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.square4.correctProgram,
      '        亀.前に進む();\n        亀.前に進む();\n    }',
      '        亀.前に進む();\n        亀.後に戻る();\n    }'
    ),
  },
  sourceVariableBugCoordinateOrder: {
    ...sourceI1To4Models.variable,
    title: '変数を使おう(1)：変数を渡す座標の順序',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.variable.correctProgram,
      '        Turtle 亀 = new Turtle(x, 3);',
      '        Turtle 亀 = new Turtle(3, x);'
    ),
  },
  sourceVariableBugVariableType: {
    ...sourceI1To4Models.variable,
    title: '変数を使おう(1)：整数変数の型',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.variable.correctProgram,
      '        int x = 1;',
      '        boolean x = 1;'
    ),
  },
  sourceVariable2BugUpdateDirection: {
    ...sourceI1To4Models.variable2,
    title: '変数を使おう(2)：代入式の演算',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.variable2.correctProgram,
      '        a = a - 1;',
      '        a = a + 1;'
    ),
  },
  sourceVariable2BugAssignmentTarget: {
    ...sourceI1To4Models.variable2,
    title: '変数を使おう(2)：代入先の変数',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.variable2.correctProgram,
      '        a = a - 1;',
      '        b = a - 1;'
    ),
  },
  sourceVariable3BugDependency: {
    ...sourceI1To4Models.variable3,
    title: '変数を使おう(3)：計算に使う変数',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.variable3.correctProgram,
      '        int y = x + 1;',
      '        int y = x - 1;'
    ),
  },
  sourceVariable3BugDeclarationOrder: {
    ...sourceI1To4Models.variable3,
    title: '変数を使おう(3)：初期化の依存関係',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.variable3.correctProgram,
      '        int y = x + 1;',
      '        int y = y + 1;'
    ),
  },
  sourceVariable4BugCoordinateDependency: {
    ...sourceI1To4Models.variable4,
    title: '変数を使おう(4)：座標の変数の取り違え',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.variable4.correctProgram,
      '        Turtle 亀 = new Turtle(a + 1, b);',
      '        Turtle 亀 = new Turtle(b + 1, a);'
    ),
  },
  sourceVariable4BugAssignmentTarget: {
    ...sourceI1To4Models.variable4,
    title: '変数を使おう(4)：代入先の変数',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.variable4.correctProgram,
      '        b = b + 1;',
      '        a = b + 1;'
    ),
  },
  sourceVariable5BugUpdateDirection: {
    ...sourceI1To4Models.variable5,
    title: '変数を使おう(5)：減算と加算',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(sourceI1To4Models.variable5.correctProgram, '        x--;', '        x++;'),
  },
  sourceVariable5BugCompoundAssignmentType: {
    ...sourceI1To4Models.variable5,
    title: '変数を使おう(5)：複合代入の値の型',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.variable5.correctProgram,
      '        y /= 3;',
      '        y /= true;'
    ),
  },
  sourceVariable6BugDependency: {
    ...sourceI1To4Models.variable6,
    title: '変数を使おう(6)：中間変数の参照',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.variable6.correctProgram,
      '        int c = b - 2;',
      '        int c = b;'
    ),
  },
  sourceVariable6BugDeclarationOrder: {
    ...sourceI1To4Models.variable6,
    title: '変数を使おう(6)：初期化の依存関係',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.variable6.correctProgram,
      '        int b = a * 2;',
      '        int b = c * 2;'
    ),
  },
  sourceVariable7BugIntegerDivision: {
    ...sourceI1To4Models.variable7,
    title: '変数を使おう(7)：整数除算と剰余',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.variable7.correctProgram,
      '        x = z / 3;',
      '        x = z % 3;'
    ),
  },
  sourceVariable7BugDeclarationOrder: {
    ...sourceI1To4Models.variable7,
    title: '変数を使おう(7)：初期化の依存関係',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.variable7.correctProgram,
      '        int z = (y * 2) + (x / 2);',
      '        int z = (z * 2) + (x / 2);'
    ),
  },
  sourceVariable8BugUpdateOrder: {
    ...sourceI1To4Models.variable8,
    title: '変数を使おう(8)：更新済みの変数の使用',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.variable8.correctProgram,
      '        y = (x + y) % 7;',
      '        y = (z + y) % 7;'
    ),
  },
  sourceVariable8BugAssignmentType: {
    ...sourceI1To4Models.variable8,
    title: '変数を使おう(8)：整数変数への代入',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.variable8.correctProgram,
      '        x = (z / 4) % 7;',
      '        x = (z / 4) == 7;'
    ),
  },
  sourceVariable9BugCoordinateDependency: {
    ...sourceI1To4Models.variable9,
    title: '変数を使おう(9)：横座標の依存関係',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.variable9.correctProgram,
      '        x = ((z / 5) + x) % 7;',
      '        x = ((z / 5) + y) % 7;'
    ),
  },
  sourceVariable9BugAssignmentType: {
    ...sourceI1To4Models.variable9,
    title: '変数を使おう(9)：整数変数への代入',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.variable9.correctProgram,
      '        x = ((z / 5) + x) % 7;',
      '        x = ((z / 5) + x) == 7;'
    ),
  },
  sourceVariable10BugRemainderOperation: {
    ...sourceI1To4Models.variable10,
    title: '変数を使おう(10)：剰余計算の演算',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.variable10.correctProgram,
      '        int w = (z + x) % 5;',
      '        int w = (z * x) % 5;'
    ),
  },
  sourceVariable10BugAssignmentType: {
    ...sourceI1To4Models.variable10,
    title: '変数を使おう(10)：整数変数への代入',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.variable10.correctProgram,
      '        int w = (z + x) % 5;',
      '        int w = (z + x) == 5;'
    ),
  },
  sourceWhile1BugConditionDirection: {
    ...sourceI1To4Models.while1,
    title: 'while文を使おう(1)：繰り返し条件の比較方向',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.while1.correctProgram,
      '        while (i < 4) {',
      '        while (i > 4) {'
    ),
  },
  sourceWhile1BugBooleanCondition: {
    ...sourceI1To4Models.while1,
    title: 'while文を使おう(1)：繰り返し条件の型',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.while1.correctProgram,
      '        while (i < 4) {',
      '        while (i) {'
    ),
  },
  sourceWhile2BugConditionDirection: {
    ...sourceI1To4Models.while2,
    title: 'while文を使おう(2)：繰り返し条件の比較方向',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.while2.correctProgram,
      '        while (i < 4) {',
      '        while (i > 4) {'
    ),
  },
  sourceWhile2BugBooleanCondition: {
    ...sourceI1To4Models.while2,
    title: 'while文を使おう(2)：繰り返し条件の型',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.while2.correctProgram,
      '        while (i < 4) {',
      '        while (i) {'
    ),
  },
  sourceWhile3BugConditionDirection: {
    ...sourceI1To4Models.while3,
    title: 'while文を使おう(3)：繰り返し条件の比較方向',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.while3.correctProgram,
      '        while (i < 2) {',
      '        while (i > 2) {'
    ),
  },
  sourceWhile3BugBooleanCondition: {
    ...sourceI1To4Models.while3,
    title: 'while文を使おう(3)：繰り返し条件の型',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.while3.correctProgram,
      '        while (i < 2) {',
      '        while (i) {'
    ),
  },
  sourceWhile4BugConditionDirection: {
    ...sourceI1To4Models.while4,
    title: 'while文を使おう(4)：繰り返し条件の比較方向',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.while4.correctProgram,
      '        while (i < 4) {',
      '        while (i > 4) {'
    ),
  },
  sourceWhile4BugBooleanCondition: {
    ...sourceI1To4Models.while4,
    title: 'while文を使おう(4)：繰り返し条件の型',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.while4.correctProgram,
      '        while (i < 4) {',
      '        while (i) {'
    ),
  },
  sourceWhile5BugConditionDirection: {
    ...sourceI1To4Models.while5,
    title: 'while文を使おう(5)：繰り返し条件の比較方向',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.while5.correctProgram,
      '        while (i < 3) {',
      '        while (i > 3) {'
    ),
  },
  sourceWhile5BugBooleanCondition: {
    ...sourceI1To4Models.while5,
    title: 'while文を使おう(5)：繰り返し条件の型',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.while5.correctProgram,
      '        while (i < 3) {',
      '        while (i) {'
    ),
  },
  sourceFor1BugConditionDirection: {
    ...sourceI1To4Models.for1,
    title: 'for文を使おう(1)：繰り返し条件の比較方向',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.for1.correctProgram,
      '        for (int i = 0; i < 3; i++) {',
      '        for (int i = 0; i > 3; i++) {'
    ),
  },
  sourceFor1BugBooleanCondition: {
    ...sourceI1To4Models.for1,
    title: 'for文を使おう(1)：繰り返し条件の型',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.for1.correctProgram,
      '        for (int i = 0; i < 3; i++) {',
      '        for (int i = 0; i; i++) {'
    ),
  },
  sourceFor2BugConditionDirection: {
    ...sourceI1To4Models.for2,
    title: 'for文を使おう(2)：繰り返し条件の比較方向',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.for2.correctProgram,
      '        for (int i = 1; i < 5; i++) {',
      '        for (int i = 1; i > 5; i++) {'
    ),
  },
  sourceFor2BugBooleanCondition: {
    ...sourceI1To4Models.for2,
    title: 'for文を使おう(2)：繰り返し条件の型',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.for2.correctProgram,
      '        for (int i = 1; i < 5; i++) {',
      '        for (int i = 1; i; i++) {'
    ),
  },
  sourceFor3BugConditionDirection: {
    ...sourceI1To4Models.for3,
    title: 'for文を使おう(3)：繰り返し条件の比較方向',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.for3.correctProgram,
      '        for (; i < 2;) {',
      '        for (; i > 2;) {'
    ),
  },
  sourceFor3BugBooleanCondition: {
    ...sourceI1To4Models.for3,
    title: 'for文を使おう(3)：繰り返し条件の型',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.for3.correctProgram,
      '        for (; i < 2;) {',
      '        for (; i;) {'
    ),
  },
  sourceFor4BugConditionDirection: {
    ...sourceI1To4Models.for4,
    title: 'for文を使おう(4)：繰り返し条件の比較方向',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.for4.correctProgram,
      '        for (; i < 3;) {',
      '        for (; i > 3;) {'
    ),
  },
  sourceFor4BugBooleanCondition: {
    ...sourceI1To4Models.for4,
    title: 'for文を使おう(4)：繰り返し条件の型',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.for4.correctProgram,
      '        for (; i < 3;) {',
      '        for (; i;) {'
    ),
  },
  sourceFor5BugAccumulation: {
    ...sourceI1To4Models.for5,
    title: 'for文を使おう(5)：合計の更新方法',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.for5.correctProgram,
      '            x += i;',
      '            x = i;'
    ),
  },
  sourceFor5BugBooleanCondition: {
    ...sourceI1To4Models.for5,
    title: 'for文を使おう(5)：for条件の型',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.for5.correctProgram,
      '        for (int i = 2; i <= 4; i++) {',
      '        for (int i = 2; i; i++) {'
    ),
  },
  sourceFor6BugConditionDirection: {
    ...sourceI1To4Models.for6,
    title: 'for文を使おう(6)：減少する変数の条件',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.for6.correctProgram,
      '        for (int i = 4; i > 0; i--) {',
      '        for (int i = 4; i < 0; i--) {'
    ),
  },
  sourceFor6BugBooleanCondition: {
    ...sourceI1To4Models.for6,
    title: 'for文を使おう(6)：for条件の型',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.for6.correctProgram,
      '        for (int i = 4; i > 0; i--) {',
      '        for (int i = 4; i; i--) {'
    ),
  },
  sourceFor7BugAccumulation: {
    ...sourceI1To4Models.for7,
    title: 'for文を使おう(7)：次のループへ渡す合計',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.for7.correctProgram,
      '            sum += i;',
      '            sum = i;'
    ),
  },
  sourceFor7BugBooleanCondition: {
    ...sourceI1To4Models.for7,
    title: 'for文を使おう(7)：後半のfor条件の型',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.for7.correctProgram,
      '        for (int i = sum / 4; i >= 0; i--) {',
      '        for (int i = sum / 4; i; i--) {'
    ),
  },
  sourceDoubleLoop1BugInnerCondition: {
    ...sourceI1To4Models.doubleLoop1,
    title: '二重ループ(1)：内側の繰り返し条件',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.doubleLoop1.correctProgram,
      '            for (int j = 0; j < 2; j++) {',
      '            for (int j = 0; j > 2; j++) {'
    ),
  },
  sourceDoubleLoop1BugInnerConditionType: {
    ...sourceI1To4Models.doubleLoop1,
    title: '二重ループ(1)：内側のfor条件の型',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.doubleLoop1.correctProgram,
      '            for (int j = 0; j < 2; j++) {',
      '            for (int j = 0; j; j++) {'
    ),
  },
  sourceDoubleLoop2BugInnerCondition: {
    ...sourceI1To4Models.doubleLoop2,
    title: '二重ループ(2)：内側の繰り返し条件',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.doubleLoop2.correctProgram,
      '            for (int j = 0; j < 2; j++) {',
      '            for (int j = 0; j > 2; j++) {'
    ),
  },
  sourceDoubleLoop2BugInnerConditionType: {
    ...sourceI1To4Models.doubleLoop2,
    title: '二重ループ(2)：内側のfor条件の型',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.doubleLoop2.correctProgram,
      '            for (int j = 0; j < 2; j++) {',
      '            for (int j = 0; j; j++) {'
    ),
  },
  sourceDoubleLoop3BugInnerDependency: {
    ...sourceI1To4Models.doubleLoop3,
    title: '二重ループ(3)：外側に依存する条件',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.doubleLoop3.correctProgram,
      '            for (int j = 0; j < i; j++) {',
      '            for (int j = 0; j > i; j++) {'
    ),
  },
  sourceDoubleLoop3BugInnerConditionType: {
    ...sourceI1To4Models.doubleLoop3,
    title: '二重ループ(3)：内側のfor条件の型',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.doubleLoop3.correctProgram,
      '            for (int j = 0; j < i; j++) {',
      '            for (int j = 0; j; j++) {'
    ),
  },
  sourceDoubleLoop4BugInclusiveInnerBound: {
    ...sourceI1To4Models.doubleLoop4,
    title: '二重ループ(4)：内側の境界の含め方',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.doubleLoop4.correctProgram,
      '            while (j >= 0) {',
      '            while (j > 0) {'
    ),
  },
  sourceDoubleLoop4BugInnerConditionType: {
    ...sourceI1To4Models.doubleLoop4,
    title: '二重ループ(4)：内側のwhile条件の型',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.doubleLoop4.correctProgram,
      '            while (j >= 0) {',
      '            while (j) {'
    ),
  },
  sourceDoubleLoop5BugInclusiveInnerBound: {
    ...sourceI1To4Models.doubleLoop5,
    title: '二重ループ(5)：内側の境界の含め方',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.doubleLoop5.correctProgram,
      '            for (int j = 0; j <= i; j++) {',
      '            for (int j = 0; j < i; j++) {'
    ),
  },
  sourceDoubleLoop5BugInnerConditionType: {
    ...sourceI1To4Models.doubleLoop5,
    title: '二重ループ(5)：内側のfor条件の型',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.doubleLoop5.correctProgram,
      '            for (int j = 0; j <= i; j++) {',
      '            for (int j = 0; j; j++) {'
    ),
  },
  sourceIf1BugTurnCondition: {
    ...sourceI1To4Models.if1,
    title: 'if文を使おう(1)：旋回する条件',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.if1.correctProgram,
      '            if (i % 3 == 2) {',
      '            if (i % 3 <= 2) {'
    ),
  },
  sourceIf1BugBooleanCondition: {
    ...sourceI1To4Models.if1,
    title: 'if文を使おう(1)：if条件の型',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.if1.correctProgram,
      '            if (i % 3 == 2) {',
      '            if (i % 3) {'
    ),
  },
  sourceIf2BugTurnCondition: {
    ...sourceI1To4Models.if2,
    title: 'if文を使おう(2)：旋回する条件',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.if2.correctProgram,
      '            if (i % 3 == 1) {',
      '            if (i % 3 <= 1) {'
    ),
  },
  sourceIf2BugBooleanCondition: {
    ...sourceI1To4Models.if2,
    title: 'if文を使おう(2)：if条件の型',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.if2.correctProgram,
      '            if (i % 3 == 1) {',
      '            if (i % 3) {'
    ),
  },
  sourceIf3BugRemainderCondition: {
    ...sourceI1To4Models.if3,
    title: 'if文を使おう(3)：剰余と整数除算の分岐',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.if3.correctProgram,
      '            if (i % 2 == 0) {',
      '            if (i / 2 == 0) {'
    ),
  },
  sourceIf3BugBooleanCondition: {
    ...sourceI1To4Models.if3,
    title: 'if文を使おう(3)：if条件の型',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.if3.correctProgram,
      '            if (i % 2 == 0) {',
      '            if (i % 2) {'
    ),
  },
  sourceIf4BugRemainderCondition: {
    ...sourceI1To4Models.if4,
    title: 'if文を使おう(4)：剰余と整数除算の分岐',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.if4.correctProgram,
      '            if (i % 3 == 0) {',
      '            if (i / 3 == 0) {'
    ),
  },
  sourceIf4BugBooleanCondition: {
    ...sourceI1To4Models.if4,
    title: 'if文を使おう(4)：if条件の型',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.if4.correctProgram,
      '            if (i % 3 == 0) {',
      '            if (i % 3) {'
    ),
  },
  sourceIf5BugRestoreHeading: {
    ...sourceI1To4Models.if5,
    title: 'if文を使おう(5)：分岐後に戻す向き',
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.if5.correctProgram,
      '            t.左を向く();',
      '            t.右を向く();'
    ),
  },
  sourceIf5BugBooleanCondition: {
    ...sourceI1To4Models.if5,
    title: 'if文を使おう(5)：if条件の型',
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.if5.correctProgram,
      '                if (j % 2 == 0) {',
      '                if (j % 2) {'
    ),
  },
} satisfies Record<string, JavaChallengeDefinition>;
