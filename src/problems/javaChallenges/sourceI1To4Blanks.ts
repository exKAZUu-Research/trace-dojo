import { sourceI1To4Models } from './sourceI1To4Models';
import { replaceSourceOnce } from './sourceModels';
import type { JavaChallengeDefinition } from './types';

export const sourceI1To4Blanks = {
  sourceStraightBlankFirstAdvance: {
    ...sourceI1To4Models.straight,
    title: '線を描こう(1)：最初の前進命令',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.straight.correctProgram,
      '        Turtle 亀 = new Turtle();\n        亀.前に進む();\n        亀.前に進む();',
      '        Turtle 亀 = new Turtle();\n        @[亀.前に進む();]@\n        亀.前に進む();'
    ),
  },
  sourceStraightBlankLastAdvance: {
    ...sourceI1To4Models.straight,
    title: '線を描こう(1)：最後の前進命令',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.straight.correctProgram,
      '        亀.前に進む();\n        亀.前に進む();\n    }',
      '        亀.前に進む();\n        @[亀.前に進む();]@\n    }'
    ),
  },
  sourceStraight2BlankFirstAdvance: {
    ...sourceI1To4Models.straight2,
    title: '線を描こう(2)：最初の前進命令',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.straight2.correctProgram,
      '        Turtle 亀 = new Turtle();\n        亀.前に進む();\n        亀.前に進む();',
      '        Turtle 亀 = new Turtle();\n        @[亀.前に進む();]@\n        亀.前に進む();'
    ),
  },
  sourceStraight2BlankLastAdvance: {
    ...sourceI1To4Models.straight2,
    title: '線を描こう(2)：最後の前進命令',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.straight2.correctProgram,
      '        亀.前に進む();\n        亀.前に進む();\n    }',
      '        亀.前に進む();\n        @[亀.前に進む();]@\n    }'
    ),
  },
  sourceStepBackBlankAdvance: {
    ...sourceI1To4Models.stepBack,
    title: '線を描こう(3)：前進命令',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.stepBack.correctProgram,
      '        亀.前に進む();',
      '        @[亀.前に進む();]@'
    ),
  },
  sourceStepBackBlankBacktrack: {
    ...sourceI1To4Models.stepBack,
    title: '線を描こう(3)：後退命令',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.stepBack.correctProgram,
      '        亀.後に戻る();',
      '        亀.@[後に戻る]@();'
    ),
  },
  sourceStepBack2BlankBacktrack: {
    ...sourceI1To4Models.stepBack2,
    title: '線を描こう(4)：途中の後退命令',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.stepBack2.correctProgram,
      '        亀.後に戻る();',
      '        亀.@[後に戻る]@();'
    ),
  },
  sourceStepBack2BlankLastAdvance: {
    ...sourceI1To4Models.stepBack2,
    title: '線を描こう(4)：最後の前進命令',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.stepBack2.correctProgram,
      '        亀.前に進む();\n        亀.前に進む();\n    }',
      '        亀.前に進む();\n        @[亀.前に進む();]@\n    }'
    ),
  },
  sourceTurnRightBlankTurn: {
    ...sourceI1To4Models.turnRight,
    title: '線を描こう(5)：向きを変える命令',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.turnRight.correctProgram,
      '        亀.右を向く();',
      '        @[亀.右を向く();]@'
    ),
  },
  sourceTurnRightBlankAfterTurn: {
    ...sourceI1To4Models.turnRight,
    title: '線を描こう(5)：旋回後の前進命令',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.turnRight.correctProgram,
      '        亀.右を向く();\n        亀.前に進む();\n    }',
      '        亀.右を向く();\n        @[亀.前に進む();]@\n    }'
    ),
  },
  sourceTurnRight2BlankTurn: {
    ...sourceI1To4Models.turnRight2,
    title: '線を描こう(6)：向きを変える命令',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.turnRight2.correctProgram,
      '        亀.右を向く();',
      '        @[亀.右を向く();]@'
    ),
  },
  sourceTurnRight2BlankAfterTurn: {
    ...sourceI1To4Models.turnRight2,
    title: '線を描こう(6)：旋回後の前進命令',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.turnRight2.correctProgram,
      '        亀.右を向く();\n        亀.前に進む();\n        亀.前に進む();',
      '        亀.右を向く();\n        @[亀.前に進む();]@\n        亀.前に進む();'
    ),
  },
  sourceTurnLeftAndRightBlankRightTurn: {
    ...sourceI1To4Models.turnLeftAndRight,
    title: '線を描こう(7)：右への旋回',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.turnLeftAndRight.correctProgram,
      '        亀.右を向く();',
      '        @[亀.右を向く();]@'
    ),
  },
  sourceTurnLeftAndRightBlankLeftTurn: {
    ...sourceI1To4Models.turnLeftAndRight,
    title: '線を描こう(7)：左への旋回',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.turnLeftAndRight.correctProgram,
      '        亀.左を向く();',
      '        @[亀.左を向く();]@'
    ),
  },
  sourceTurnLeftAndRight2BlankRightTurn: {
    ...sourceI1To4Models.turnLeftAndRight2,
    title: '線を描こう(8)：右への旋回',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.turnLeftAndRight2.correctProgram,
      '        亀.右を向く();',
      '        @[亀.右を向く();]@'
    ),
  },
  sourceTurnLeftAndRight2BlankLeftTurn: {
    ...sourceI1To4Models.turnLeftAndRight2,
    title: '線を描こう(8)：左への旋回',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.turnLeftAndRight2.correctProgram,
      '        亀.左を向く();',
      '        @[亀.左を向く();]@'
    ),
  },
  sourceTurnLeftAndRight3BlankMiddleTurn: {
    ...sourceI1To4Models.turnLeftAndRight3,
    title: '線を描こう(9)：中央の旋回',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.turnLeftAndRight3.correctProgram,
      '        亀.左を向く();',
      '        @[亀.左を向く();]@'
    ),
  },
  sourceTurnLeftAndRight3BlankLastTurn: {
    ...sourceI1To4Models.turnLeftAndRight3,
    title: '線を描こう(9)：最後の旋回',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.turnLeftAndRight3.correctProgram,
      '        亀.前に進む();\n        亀.右を向く();\n        亀.前に進む();',
      '        亀.前に進む();\n        @[亀.右を向く();]@\n        亀.前に進む();'
    ),
  },
  sourceTurnLeftAndRight4BlankRightTurn: {
    ...sourceI1To4Models.turnLeftAndRight4,
    title: '線を描こう(10)：右への旋回',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.turnLeftAndRight4.correctProgram,
      '        亀.右を向く();',
      '        @[亀.右を向く();]@'
    ),
  },
  sourceTurnLeftAndRight4BlankLeftTurn: {
    ...sourceI1To4Models.turnLeftAndRight4,
    title: '線を描こう(10)：左への旋回',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.turnLeftAndRight4.correctProgram,
      '        亀.左を向く();',
      '        @[亀.左を向く();]@'
    ),
  },
  sourceSquare1BlankFirstTurn: {
    ...sourceI1To4Models.square1,
    title: '図形を描こう(1)：最初の旋回',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.square1.correctProgram,
      '        Turtle 亀 = new Turtle();\n        亀.前に進む();\n        亀.右を向く();\n        亀.前に進む();\n        亀.右を向く();',
      '        Turtle 亀 = new Turtle();\n        亀.前に進む();\n        @[亀.右を向く();]@\n        亀.前に進む();\n        亀.右を向く();'
    ),
  },
  sourceSquare1BlankLastAdvance: {
    ...sourceI1To4Models.square1,
    title: '図形を描こう(1)：最後の前進',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.square1.correctProgram,
      '        亀.右を向く();\n        亀.前に進む();\n    }',
      '        亀.右を向く();\n        @[亀.前に進む();]@\n    }'
    ),
  },
  sourceSquare2BlankFirstTurn: {
    ...sourceI1To4Models.square2,
    title: '図形を描こう(2)：最初の旋回',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.square2.correctProgram,
      '        Turtle 亀 = new Turtle(2, 1);\n        亀.前に進む();\n        亀.右を向く();\n        亀.前に進む();\n        亀.右を向く();',
      '        Turtle 亀 = new Turtle(2, 1);\n        亀.前に進む();\n        @[亀.右を向く();]@\n        亀.前に進む();\n        亀.右を向く();'
    ),
  },
  sourceSquare2BlankLastAdvance: {
    ...sourceI1To4Models.square2,
    title: '図形を描こう(2)：最後の前進',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.square2.correctProgram,
      '        亀.右を向く();\n        亀.前に進む();\n    }',
      '        亀.右を向く();\n        @[亀.前に進む();]@\n    }'
    ),
  },
  sourceSquare3BlankFirstTurn: {
    ...sourceI1To4Models.square3,
    title: '図形を描こう(3)：最初の旋回',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.square3.correctProgram,
      '        Turtle 亀 = new Turtle(2, 3);\n        亀.前に進む();\n        亀.左を向く();\n        亀.前に進む();\n        亀.左を向く();',
      '        Turtle 亀 = new Turtle(2, 3);\n        亀.前に進む();\n        @[亀.左を向く();]@\n        亀.前に進む();\n        亀.左を向く();'
    ),
  },
  sourceSquare3BlankLastAdvance: {
    ...sourceI1To4Models.square3,
    title: '図形を描こう(3)：最後の前進',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.square3.correctProgram,
      '        亀.左を向く();\n        亀.前に進む();\n    }',
      '        亀.左を向く();\n        @[亀.前に進む();]@\n    }'
    ),
  },
  sourceSquare4BlankFirstTurn: {
    ...sourceI1To4Models.square4,
    title: '図形を描こう(4)：最初の旋回',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.square4.correctProgram,
      '        Turtle 亀 = new Turtle();\n        亀.前に進む();\n        亀.前に進む();\n        亀.右を向く();\n        亀.前に進む();\n        亀.前に進む();\n        亀.右を向く();',
      '        Turtle 亀 = new Turtle();\n        亀.前に進む();\n        亀.前に進む();\n        @[亀.右を向く();]@\n        亀.前に進む();\n        亀.前に進む();\n        亀.右を向く();'
    ),
  },
  sourceSquare4BlankLastAdvance: {
    ...sourceI1To4Models.square4,
    title: '図形を描こう(4)：最後の前進',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.square4.correctProgram,
      '        亀.前に進む();\n        亀.前に進む();\n    }',
      '        亀.前に進む();\n        @[亀.前に進む();]@\n    }'
    ),
  },
  sourceVariableBlankCoordinate: {
    ...sourceI1To4Models.variable,
    title: '変数を使おう(1)：変数を座標に使う',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.variable.correctProgram,
      '        Turtle 亀 = new Turtle(x, 3);',
      '        Turtle 亀 = new Turtle(@[x]@, 3);'
    ),
  },
  sourceVariableBlankAdvance: {
    ...sourceI1To4Models.variable,
    title: '変数を使おう(1)：作成後の前進',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.variable.correctProgram,
      '        亀.前に進む();',
      '        @[亀.前に進む();]@'
    ),
  },
  sourceVariable2BlankAssignment: {
    ...sourceI1To4Models.variable2,
    title: '変数を使おう(2)：変数の更新式',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.variable2.correctProgram,
      '        a = a - 1;',
      '        a = @[a - 1]@;'
    ),
  },
  sourceVariable2BlankCoordinate: {
    ...sourceI1To4Models.variable2,
    title: '変数を使おう(2)：更新後の座標',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.variable2.correctProgram,
      '        Turtle 亀 = new Turtle(2, a);',
      '        Turtle 亀 = new Turtle(2, @[a]@);'
    ),
  },
  sourceVariable3BlankUpdate: {
    ...sourceI1To4Models.variable3,
    title: '変数を使おう(3)：変数の更新式',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.variable3.correctProgram,
      '        x = x + 1;',
      '        @[x = x + 1;]@'
    ),
  },
  sourceVariable3BlankDependency: {
    ...sourceI1To4Models.variable3,
    title: '変数を使おう(3)：次の変数の計算式',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.variable3.correctProgram,
      '        int y = x + 1;',
      '        @[int y = x + 1;]@'
    ),
  },
  sourceVariable4BlankDependency: {
    ...sourceI1To4Models.variable4,
    title: '変数を使おう(4)：変数を使った引き算',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.variable4.correctProgram,
      '        int a = b - 2;',
      '        int a = @[b - 2]@;'
    ),
  },
  sourceVariable4BlankCoordinate: {
    ...sourceI1To4Models.variable4,
    title: '変数を使おう(4)：座標の計算式',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.variable4.correctProgram,
      '        Turtle 亀 = new Turtle(a + 1, b);',
      '        Turtle 亀 = new Turtle(@[a + 1, b]@);'
    ),
  },
  sourceVariable5BlankDecrement: {
    ...sourceI1To4Models.variable5,
    title: '変数を使おう(5)：減算による更新',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(sourceI1To4Models.variable5.correctProgram, '        x--;', '        @[x--;]@'),
  },
  sourceVariable5BlankCoordinate: {
    ...sourceI1To4Models.variable5,
    title: '変数を使おう(5)：更新した変数を座標に使う',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.variable5.correctProgram,
      '        Turtle 亀 = new Turtle(x + 1, y + 1);',
      '        Turtle 亀 = new Turtle(@[x + 1, y + 1]@);'
    ),
  },
  sourceVariable6BlankMultiplication: {
    ...sourceI1To4Models.variable6,
    title: '変数を使おう(6)：変数の倍数',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.variable6.correctProgram,
      '        int b = a * 2;',
      '        int b = @[a * 2]@;'
    ),
  },
  sourceVariable6BlankDependency: {
    ...sourceI1To4Models.variable6,
    title: '変数を使おう(6)：次の変数への依存',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.variable6.correctProgram,
      '        int c = b - 2;',
      '        int c = @[b - 2]@;'
    ),
  },
  sourceVariable7BlankDependency: {
    ...sourceI1To4Models.variable7,
    title: '変数を使おう(7)：複数変数の計算',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.variable7.correctProgram,
      '        int z = (y * 2) + (x / 2);',
      '        int z = @[(y * 2) + (x / 2)]@;'
    ),
  },
  sourceVariable7BlankDivision: {
    ...sourceI1To4Models.variable7,
    title: '変数を使おう(7)：整数除算で座標を求める',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.variable7.correctProgram,
      '        x = z / 3;',
      '        x = @[z / 3]@;'
    ),
  },
  sourceVariable8BlankXCoordinate: {
    ...sourceI1To4Models.variable8,
    title: '変数を使おう(8)：剰余で横座標を求める',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.variable8.correctProgram,
      '        x = (z / 4) % 7;',
      '        x = @[(z / 4) % 7]@;'
    ),
  },
  sourceVariable8BlankYCoordinate: {
    ...sourceI1To4Models.variable8,
    title: '変数を使おう(8)：更新した変数を使う',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.variable8.correctProgram,
      '        y = (x + y) % 7;',
      '        y = @[(x + y) % 7]@;'
    ),
  },
  sourceVariable9BlankXCoordinate: {
    ...sourceI1To4Models.variable9,
    title: '変数を使おう(9)：横座標の計算',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.variable9.correctProgram,
      '        x = ((z / 5) + x) % 7;',
      '        x = @[((z / 5) + x) % 7]@;'
    ),
  },
  sourceVariable9BlankYCoordinate: {
    ...sourceI1To4Models.variable9,
    title: '変数を使おう(9)：縦座標の計算',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.variable9.correctProgram,
      '        y = ((x * 2) + y) % 7;',
      '        y = @[((x * 2) + y) % 7]@;'
    ),
  },
  sourceVariable10BlankRemainder: {
    ...sourceI1To4Models.variable10,
    title: '変数を使おう(10)：中間変数の剰余',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.variable10.correctProgram,
      '        int w = (z + x) % 5;',
      '        int w = @[(z + x) % 5]@;'
    ),
  },
  sourceVariable10BlankCoordinate: {
    ...sourceI1To4Models.variable10,
    title: '変数を使おう(10)：中間変数で座標を求める',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.variable10.correctProgram,
      '        x = ((z / 6) + w) % 7;',
      '        x = @[((z / 6) + w) % 7]@;'
    ),
  },
  sourceWhile1BlankCondition: {
    ...sourceI1To4Models.while1,
    title: 'while文を使おう(1)：繰り返し条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.while1.correctProgram,
      '        while (i < 4) {',
      '        while (@[i < 4]@) {'
    ),
  },
  sourceWhile1BlankUpdate: {
    ...sourceI1To4Models.while1,
    title: 'while文を使おう(1)：繰り返し変数の更新',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.while1.correctProgram,
      '            i++;',
      '            @[i++]@;'
    ),
  },
  sourceWhile2BlankCondition: {
    ...sourceI1To4Models.while2,
    title: 'while文を使おう(2)：繰り返し条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.while2.correctProgram,
      '        while (i < 4) {',
      '        while (@[i < 4]@) {'
    ),
  },
  sourceWhile2BlankUpdate: {
    ...sourceI1To4Models.while2,
    title: 'while文を使おう(2)：繰り返し変数の更新',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.while2.correctProgram,
      '            i++;',
      '            @[i++]@;'
    ),
  },
  sourceWhile3BlankCondition: {
    ...sourceI1To4Models.while3,
    title: 'while文を使おう(3)：繰り返し条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.while3.correctProgram,
      '        while (i < 2) {',
      '        while (@[i < 2]@) {'
    ),
  },
  sourceWhile3BlankUpdate: {
    ...sourceI1To4Models.while3,
    title: 'while文を使おう(3)：繰り返し変数の更新',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.while3.correctProgram,
      '            i++;',
      '            @[i++]@;'
    ),
  },
  sourceWhile4BlankCondition: {
    ...sourceI1To4Models.while4,
    title: 'while文を使おう(4)：繰り返し条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.while4.correctProgram,
      '        while (i < 4) {',
      '        while (@[i < 4]@) {'
    ),
  },
  sourceWhile4BlankUpdate: {
    ...sourceI1To4Models.while4,
    title: 'while文を使おう(4)：繰り返し変数の更新',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.while4.correctProgram,
      '            i++;',
      '            @[i++]@;'
    ),
  },
  sourceWhile5BlankCondition: {
    ...sourceI1To4Models.while5,
    title: 'while文を使おう(5)：繰り返し条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.while5.correctProgram,
      '        while (i < 3) {',
      '        while (@[i < 3]@) {'
    ),
  },
  sourceWhile5BlankUpdate: {
    ...sourceI1To4Models.while5,
    title: 'while文を使おう(5)：繰り返し変数の更新',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.while5.correctProgram,
      '            i++;',
      '            @[i++]@;'
    ),
  },
  sourceFor1BlankCondition: {
    ...sourceI1To4Models.for1,
    title: 'for文を使おう(1)：繰り返し条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.for1.correctProgram,
      '        for (int i = 0; i < 3; i++) {',
      '        for (int i = 0; @[i < 3]@; i++) {'
    ),
  },
  sourceFor1BlankUpdate: {
    ...sourceI1To4Models.for1,
    title: 'for文を使おう(1)：繰り返し変数の更新',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.for1.correctProgram,
      '        for (int i = 0; i < 3; i++) {',
      '        for (int i = 0; i < 3; @[i++]@) {'
    ),
  },
  sourceFor2BlankCondition: {
    ...sourceI1To4Models.for2,
    title: 'for文を使おう(2)：繰り返し条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.for2.correctProgram,
      '        for (int i = 1; i < 5; i++) {',
      '        for (int i = 1; @[i < 5]@; i++) {'
    ),
  },
  sourceFor2BlankUpdate: {
    ...sourceI1To4Models.for2,
    title: 'for文を使おう(2)：繰り返し変数の更新',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.for2.correctProgram,
      '        for (int i = 1; i < 5; i++) {',
      '        for (int i = 1; i < 5; @[i++]@) {'
    ),
  },
  sourceFor3BlankCondition: {
    ...sourceI1To4Models.for3,
    title: 'for文を使おう(3)：繰り返し条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.for3.correctProgram,
      '        for (; i < 2;) {',
      '        for (; @[i < 2]@;) {'
    ),
  },
  sourceFor3BlankUpdate: {
    ...sourceI1To4Models.for3,
    title: 'for文を使おう(3)：繰り返し変数の更新',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.for3.correctProgram,
      '            i++;',
      '            @[i++]@;'
    ),
  },
  sourceFor4BlankCondition: {
    ...sourceI1To4Models.for4,
    title: 'for文を使おう(4)：繰り返し条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.for4.correctProgram,
      '        for (; i < 3;) {',
      '        for (; @[i < 3]@;) {'
    ),
  },
  sourceFor4BlankUpdate: {
    ...sourceI1To4Models.for4,
    title: 'for文を使おう(4)：繰り返し変数の更新',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.for4.correctProgram,
      '            i++;',
      '            @[i++]@;'
    ),
  },
  sourceFor5BlankCondition: {
    ...sourceI1To4Models.for5,
    title: 'for文を使おう(5)：繰り返し条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.for5.correctProgram,
      '        for (int i = 2; i <= 4; i++) {',
      '        for (int i = 2; @[i <= 4]@; i++) {'
    ),
  },
  sourceFor5BlankUpdate: {
    ...sourceI1To4Models.for5,
    title: 'for文を使おう(5)：繰り返し変数の更新',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.for5.correctProgram,
      '        for (int i = 2; i <= 4; i++) {',
      '        for (int i = 2; i <= 4; @[i++]@) {'
    ),
  },
  sourceFor6BlankCondition: {
    ...sourceI1To4Models.for6,
    title: 'for文を使おう(6)：繰り返し条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.for6.correctProgram,
      '        for (int i = 4; i > 0; i--) {',
      '        for (int i = 4; @[i > 0]@; i--) {'
    ),
  },
  sourceFor6BlankUpdate: {
    ...sourceI1To4Models.for6,
    title: 'for文を使おう(6)：繰り返し変数の更新',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.for6.correctProgram,
      '        for (int i = 4; i > 0; i--) {',
      '        for (int i = 4; i > 0; @[i--]@) {'
    ),
  },
  sourceFor7BlankAccumulation: {
    ...sourceI1To4Models.for7,
    title: 'for文を使おう(7)：次のループに渡す合計',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.for7.correctProgram,
      '            sum += i;',
      '            @[sum += i;]@'
    ),
  },
  sourceFor7BlankSecondLoopStart: {
    ...sourceI1To4Models.for7,
    title: 'for文を使おう(7)：後半のループの初期値',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.for7.correctProgram,
      '        for (int i = sum / 4; i >= 0; i--) {',
      '        for (int i = @[sum / 4]@; i >= 0; i--) {'
    ),
  },
  sourceDoubleLoop1BlankOuterCondition: {
    ...sourceI1To4Models.doubleLoop1,
    title: '二重ループ(1)：外側の繰り返し条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.doubleLoop1.correctProgram,
      '        for (int i = 0; i < 2; i++) {',
      '        for (int i = 0; @[i < 2]@; i++) {'
    ),
  },
  sourceDoubleLoop1BlankInnerCondition: {
    ...sourceI1To4Models.doubleLoop1,
    title: '二重ループ(1)：内側の繰り返し条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.doubleLoop1.correctProgram,
      '            for (int j = 0; j < 2; j++) {',
      '            for (int j = 0; @[j < 2]@; j++) {'
    ),
  },
  sourceDoubleLoop2BlankOuterCondition: {
    ...sourceI1To4Models.doubleLoop2,
    title: '二重ループ(2)：外側の繰り返し条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.doubleLoop2.correctProgram,
      '        for (int i = 0; i < 2; i++) {',
      '        for (int i = 0; @[i < 2]@; i++) {'
    ),
  },
  sourceDoubleLoop2BlankInnerCondition: {
    ...sourceI1To4Models.doubleLoop2,
    title: '二重ループ(2)：内側の繰り返し条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.doubleLoop2.correctProgram,
      '            for (int j = 0; j < 2; j++) {',
      '            for (int j = 0; @[j < 2]@; j++) {'
    ),
  },
  sourceDoubleLoop3BlankOuterUpdate: {
    ...sourceI1To4Models.doubleLoop3,
    title: '二重ループ(3)：外側の変数の更新',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.doubleLoop3.correctProgram,
      '        for (int i = 3; i > 0; i--) {',
      '        for (int i = 3; i > 0; @[i--]@) {'
    ),
  },
  sourceDoubleLoop3BlankInnerBound: {
    ...sourceI1To4Models.doubleLoop3,
    title: '二重ループ(3)：外側に依存する条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.doubleLoop3.correctProgram,
      '            for (int j = 0; j < i; j++) {',
      '            for (int j = 0; @[j < i]@; j++) {'
    ),
  },
  sourceDoubleLoop4BlankInnerStart: {
    ...sourceI1To4Models.doubleLoop4,
    title: '二重ループ(4)：内側の変数の初期化',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.doubleLoop4.correctProgram,
      '            int j = i;',
      '            @[int j = i;]@'
    ),
  },
  sourceDoubleLoop4BlankInnerCondition: {
    ...sourceI1To4Models.doubleLoop4,
    title: '二重ループ(4)：内側の繰り返し条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.doubleLoop4.correctProgram,
      '            while (j >= 0) {',
      '            while (@[j >= 0]@) {'
    ),
  },
  sourceDoubleLoop5BlankFirstInnerBound: {
    ...sourceI1To4Models.doubleLoop5,
    title: '二重ループ(5)：最初の内側の条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.doubleLoop5.correctProgram,
      '            for (int j = 0; j <= i; j++) {',
      '            for (int j = 0; @[j <= i]@; j++) {'
    ),
  },
  sourceDoubleLoop5BlankSecondInnerBound: {
    ...sourceI1To4Models.doubleLoop5,
    title: '二重ループ(5)：次の内側の条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.doubleLoop5.correctProgram,
      '            for (int k = 0; k < i; k++) {',
      '            for (int k = 0; @[k < i]@; k++) {'
    ),
  },
  sourceIf1BlankCondition: {
    ...sourceI1To4Models.if1,
    title: 'if文を使おう(1)：分岐条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.if1.correctProgram,
      '            if (i % 3 == 2) {',
      '            if (@[i % 3 == 2]@) {'
    ),
  },
  sourceIf1BlankBranchTurn: {
    ...sourceI1To4Models.if1,
    title: 'if文を使おう(1)：条件に応じた旋回',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.if1.correctProgram,
      '                t.右を向く();',
      '                @[t.右を向く();]@'
    ),
  },
  sourceIf2BlankCondition: {
    ...sourceI1To4Models.if2,
    title: 'if文を使おう(2)：分岐条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.if2.correctProgram,
      '            if (i % 3 == 1) {',
      '            if (@[i % 3 == 1]@) {'
    ),
  },
  sourceIf2BlankBranchTurn: {
    ...sourceI1To4Models.if2,
    title: 'if文を使おう(2)：条件成立時の旋回',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.if2.correctProgram,
      '                t.左を向く();',
      '                @[t.左を向く();]@'
    ),
  },
  sourceIf3BlankCondition: {
    ...sourceI1To4Models.if3,
    title: 'if文を使おう(3)：分岐条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.if3.correctProgram,
      '            if (i % 2 == 0) {',
      '            if (@[i % 2 == 0]@) {'
    ),
  },
  sourceIf3BlankBranchTurn: {
    ...sourceI1To4Models.if3,
    title: 'if文を使おう(3)：条件に応じた旋回',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.if3.correctProgram,
      '                t.右を向く();',
      '                @[t.右を向く();]@'
    ),
  },
  sourceIf4BlankCondition: {
    ...sourceI1To4Models.if4,
    title: 'if文を使おう(4)：分岐条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.if4.correctProgram,
      '            if (i % 3 == 0) {',
      '            if (@[i % 3]@ == 0) {'
    ),
  },
  sourceIf4BlankBranchTurn: {
    ...sourceI1To4Models.if4,
    title: 'if文を使おう(4)：条件に応じた旋回',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.if4.correctProgram,
      '                t.右を向く();',
      '                @[t.右を向く();]@'
    ),
  },
  sourceIf5BlankCondition: {
    ...sourceI1To4Models.if5,
    title: 'if文を使おう(5)：分岐条件',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.if5.correctProgram,
      '                if (j % 2 == 0) {',
      '                if (@[j % 2 == 0]@) {'
    ),
  },
  sourceIf5BlankBranchTurn: {
    ...sourceI1To4Models.if5,
    title: 'if文を使おう(5)：条件に応じた旋回',
    problemFormat: 'fillInBlank',
    starterProgram: replaceSourceOnce(
      sourceI1To4Models.if5.correctProgram,
      '                    t.右を向く();',
      '                    @[t.右を向く();]@'
    ),
  },
} satisfies Record<string, JavaChallengeDefinition>;
