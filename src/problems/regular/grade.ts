import { zenkakuAlphanumericalsToHankaku } from '@willbooster/shared-lib';
import fastDeepEqual from 'fast-deep-equal';

import type { ColorChar } from '../../types';
import type { TraceItemVariable, TurtleTrace } from '../traceProgram';

export interface RegularGradingResult {
  readonly status: 'correct' | 'incorrect';
  readonly incorrectLocations: readonly string[];
  readonly hintText: string;
}

export function gradeRegularAnswers(input: {
  expectedBoard: string;
  expectedTurtles: readonly TurtleTrace[];
  expectedVariables: Readonly<TraceItemVariable>;
  answerBoard: readonly (readonly ColorChar[])[];
  answerTurtles: readonly TurtleTrace[];
  answerVariables: Readonly<Record<string, string>>;
  initialVariables: Readonly<Record<string, string>>;
  sourceLine?: string;
}): RegularGradingResult {
  const incorrectLocations: string[] = [];
  let hintText = '';

  if (
    !fastDeepEqual(
      input.expectedTurtles.toSorted(compareTurtlePositions),
      input.answerTurtles.toSorted(compareTurtlePositions)
    )
  ) {
    incorrectLocations.push('亀');
  }
  if (!fastDeepEqual(parseBoard(input.expectedBoard), input.answerBoard)) {
    incorrectLocations.push('盤面（マスの色）');
  }
  for (const [name, value] of Object.entries(input.answerVariables)) {
    if (
      zenkakuAlphanumericalsToHankaku(value) !== zenkakuAlphanumericalsToHankaku(String(input.expectedVariables[name]))
    ) {
      const isExpression = /[+\-*/%()[\]\\.]/.test(name);
      incorrectLocations.push(isExpression ? `式「${name}」` : `変数${name}`);
      if (input.initialVariables[name] === String(input.expectedVariables[name])) {
        hintText += hintText ? '\n\n' : '\n\nヒント: ';
        hintText +=
          '変数を更新する代入演算子（=, +=, ++）などがなければ、計算が行われても変数の値は更新されません。代入されない限り、変数の値が変わらないことに注意してください';
      }
      if (input.sourceLine?.includes(' % ')) {
        hintText += hintText ? '\n\n' : '\n\nヒント: ';
        hintText +=
          '「%」は剰余算の演算子です。%の右側の数値で左側の数値を割った数の余りです。左右の数値が整数であれば、商も余りも整数になります。例えば、「1 % 7」は1を7で割った余りの数になるので1、「0 % 7」は0、「2 % 7」は2、「7 % 7」は0、「10 % 7」は3になります。';
      }
    }
  }

  return {
    status: incorrectLocations.length === 0 ? 'correct' : 'incorrect',
    incorrectLocations,
    hintText,
  };
}

function compareTurtlePositions(a: TurtleTrace, b: TurtleTrace): number {
  return a.x - b.x || a.y - b.y;
}

function parseBoard(boardString: string): ColorChar[][] {
  return (
    boardString
      .trim()
      .split('\n')
      .filter((line) => line.trim() !== '')
      // oxlint-disable-next-line typescript/no-misused-spread -- Board cells are single ASCII color markers.
      .map((line) => [...line.trim()]) as ColorChar[][]
  );
}
