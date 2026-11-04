import fastDeepEqual from 'fast-deep-equal';

import type { ColorChar } from '../../types';
import type { TraceItemVariable, TurtleTrace } from '../trace';

export interface RegularGradingResult {
  readonly status: 'correct' | 'incorrect';
  readonly incorrectLocations: readonly string[];
  readonly hintText: string;
}

const ASSIGNMENT_HINT =
  '変数を更新する代入演算子（=, +=, ++）などがなければ、計算が行われても変数の値は更新されません。代入されない限り、変数の値が変わらないことに注意してください';
const REMAINDER_HINT =
  '「%」は剰余算の演算子です。%の右側の数値で左側の数値を割った数の余りです。左右の数値が整数であれば、商も余りも整数になります。例えば、「1 % 7」は1を7で割った余りの数になるので1、「0 % 7」は0、「2 % 7」は2、「7 % 7」は0、「10 % 7」は3になります。';

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
  const hints: string[] = [];

  if (!fastDeepEqual(input.expectedTurtles.toSorted(compareTurtles), input.answerTurtles.toSorted(compareTurtles))) {
    incorrectLocations.push('亀');
  }
  if (!fastDeepEqual(parseBoard(input.expectedBoard), input.answerBoard)) {
    incorrectLocations.push('盤面（マスの色）');
  }
  for (const [name, value] of Object.entries(input.answerVariables)) {
    const expected = input.expectedVariables[name];
    if (normalizeAnswer(value, expected) === normalizeAnswer(String(expected), expected)) continue;

    const isExpression = /[+\-*/%()[\]\\.]/.test(name);
    incorrectLocations.push(isExpression ? `式「${name}」` : `変数${name}`);
    if (input.initialVariables[name] === String(expected)) hints.push(ASSIGNMENT_HINT);
    if (input.sourceLine?.includes(' % ')) hints.push(REMAINDER_HINT);
  }

  return {
    status: incorrectLocations.length === 0 ? 'correct' : 'incorrect',
    incorrectLocations,
    hintText: hints.length > 0 ? `\n\nヒント: ${hints.join('\n\n')}` : '',
  };
}

function normalizeAnswer(value: string, expected: TraceItemVariable[string]): string {
  const normalized = value.normalize('NFKC');
  // Japanese IMEs turn the minus key into a prolonged sound mark, which means a minus sign only in a numeric value.
  return typeof expected === 'number' ? normalized.replaceAll(/[ー‐‑‒–—―−]/g, '-') : normalized;
}

function compareTurtles(a: TurtleTrace, b: TurtleTrace): number {
  return a.x - b.x || a.y - b.y || a.dir.localeCompare(b.dir) || a.color.localeCompare(b.color);
}

export function parseBoard(boardString: string): ColorChar[][] {
  return (
    boardString
      .trim()
      .split('\n')
      .filter((line) => line.trim() !== '')
      // oxlint-disable-next-line typescript/no-misused-spread -- Board cells are single ASCII color markers.
      .map((line) => [...line.trim()]) as ColorChar[][]
  );
}
