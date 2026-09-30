import { describe, expect, test } from 'vitest';

import { instantiateProblem } from '../../src/problems/instantiateProblem';
import { gradeRegularAnswers } from '../../src/problems/regular/grade';
import type { TraceItemVariable, TurtleTrace } from '../../src/problems/traceProgram';
import type { ColorChar } from '../../src/types';

const problem = instantiateProblem('test1', 'java', '');
if (!problem) throw new Error('Failed to instantiate test1.');
const finalTraceItem = problem.traceItems.at(-1);
if (!finalTraceItem) throw new Error('The traced program has no final state.');

const boardCells = (board: string): ColorChar[][] =>
  board
    .trim()
    .split('\n')
    // oxlint-disable-next-line typescript/no-misused-spread -- Board cells are single ASCII color markers.
    .map((row) => [...row.trim()] as ColorChar[]);

interface GradingInput {
  expectedBoard: string;
  expectedTurtles: TurtleTrace[];
  expectedVariables: TraceItemVariable;
  answerBoard: ColorChar[][];
  answerTurtles: TurtleTrace[];
  answerVariables: Record<string, string>;
  initialVariables: Record<string, string>;
  sourceLine?: string;
}

const answerFor = (traceItem = finalTraceItem): GradingInput => ({
  expectedBoard: traceItem.board,
  expectedTurtles: traceItem.turtles,
  expectedVariables: traceItem.vars,
  answerBoard: boardCells(traceItem.board),
  answerTurtles: traceItem.turtles,
  answerVariables: {},
  initialVariables: {},
  sourceLine: undefined,
});

const assignmentHint =
  '変数を更新する代入演算子（=, +=, ++）などがなければ、計算が行われても変数の値は更新されません。代入されない限り、変数の値が変わらないことに注意してください';
const remainderHint =
  '「%」は剰余算の演算子です。%の右側の数値で左側の数値を割った数の余りです。左右の数値が整数であれば、商も余りも整数になります。例えば、「1 % 7」は1を7で割った余りの数になるので1、「0 % 7」は0、「2 % 7」は2、「7 % 7」は0、「10 % 7」は3になります。';

describe('regular problem grading', () => {
  test('accepts a traced final state and an empty-turtle initial state', () => {
    expect(gradeRegularAnswers(answerFor())).toEqual({ status: 'correct', incorrectLocations: [], hintText: '' });
    expect(gradeRegularAnswers(answerFor(problem.traceItems[0]))).toEqual({
      status: 'correct',
      incorrectLocations: [],
      hintText: '',
    });
  });

  test.each([
    ['x coordinate', (turtle: TurtleTrace) => [{ ...turtle, x: turtle.x + 1 }]],
    ['y coordinate', (turtle: TurtleTrace) => [{ ...turtle, y: turtle.y - 1 }]],
    ['direction', (turtle: TurtleTrace) => [{ ...turtle, dir: 'E' }]],
    ['color', (turtle: TurtleTrace) => [{ ...turtle, color: 'R' }]],
    ['missing turtle', () => []],
    ['extra turtle', (turtle: TurtleTrace) => [turtle, { ...turtle, x: turtle.x + 1 }]],
  ] as const)('rejects a %s mismatch', (_name, makeTurtles) => {
    const turtle = finalTraceItem.turtles[0];
    expect(gradeRegularAnswers({ ...answerFor(), answerTurtles: makeTurtles(turtle) })).toMatchObject({
      status: 'incorrect',
      incorrectLocations: ['亀'],
    });
  });

  test('accepts turtles in a different insertion order without changing input', () => {
    const first = finalTraceItem.turtles[0];
    const second = { ...first, x: first.x + 1 };
    const expectedTurtles = Object.freeze([Object.freeze(second), Object.freeze({ ...first })]);
    const answerTurtles = Object.freeze([Object.freeze({ ...first }), Object.freeze({ ...second })]);
    const answerBoard = boardCells(finalTraceItem.board).map((row) => Object.freeze(row));
    Object.freeze(answerBoard);
    const input = {
      ...answerFor(),
      expectedTurtles,
      answerTurtles,
      answerBoard,
    };

    expect(gradeRegularAnswers(input)).toEqual({ status: 'correct', incorrectLocations: [], hintText: '' });
    expect(expectedTurtles).toEqual([second, first]);
    expect(answerTurtles).toEqual([first, second]);
    expect(answerBoard).toEqual(boardCells(finalTraceItem.board));
  });

  test('accepts co-located turtles in a different insertion order', () => {
    const first = finalTraceItem.turtles[0];
    const second = { ...first, dir: 'E', color: 'R' };

    expect(
      gradeRegularAnswers({ ...answerFor(), expectedTurtles: [first, second], answerTurtles: [second, first] })
    ).toEqual({ status: 'correct', incorrectLocations: [], hintText: '' });
  });

  test('reports turtle, board, variable, and expression errors in display order', () => {
    const input = answerFor();
    input.answerBoard[0][0] = 'R';
    input.answerTurtles = [];
    input.expectedVariables = { count: 2, 'count + 1': 3 };
    input.answerVariables = { count: '1', 'count + 1': '2' };
    input.initialVariables = { count: '0', 'count + 1': '0' };

    expect(gradeRegularAnswers(input)).toEqual({
      status: 'incorrect',
      incorrectLocations: ['亀', '盤面（マスの色）', '変数count', '式「count + 1」'],
      hintText: '',
    });
  });

  test('normalizes full-width numbers and letters in variable and expression answers', () => {
    const input = answerFor();
    input.expectedVariables = { count: 12, 'name + 1': 'Ａ３' };
    input.answerVariables = { count: '１２', 'name + 1': 'A3' };

    expect(gradeRegularAnswers(input)).toEqual({ status: 'correct', incorrectLocations: [], hintText: '' });
  });

  test('does not show hints for a correct answer on a remainder line', () => {
    const input = answerFor();
    input.expectedVariables = { count: 1 };
    input.answerVariables = { count: '1' };
    input.initialVariables = { count: '1' };
    input.sourceLine = 'count = 7 % 5;';

    expect(gradeRegularAnswers(input)).toEqual({ status: 'correct', incorrectLocations: [], hintText: '' });
  });

  test('shows both existing hints for a wrong variable answer on a remainder line', () => {
    const input = answerFor();
    input.expectedVariables = { count: 1 };
    input.answerVariables = { count: '2' };
    input.initialVariables = { count: '1' };
    input.sourceLine = 'count = 7 % 5;';

    expect(gradeRegularAnswers(input)).toEqual({
      status: 'incorrect',
      incorrectLocations: ['変数count'],
      hintText: `\n\nヒント: ${assignmentHint}\n\n${remainderHint}`,
    });
  });

  test('only shows the remainder hint when the initial value differs from the expected value', () => {
    const input = answerFor();
    input.expectedVariables = { count: 2 };
    input.answerVariables = { count: '1' };
    input.initialVariables = { count: '0' };
    input.sourceLine = 'count = 7 % 5;';

    expect(gradeRegularAnswers(input)).toEqual({
      status: 'incorrect',
      incorrectLocations: ['変数count'],
      hintText: `\n\nヒント: ${remainderHint}`,
    });
  });

  test('only shows the assignment hint without a remainder operation', () => {
    const input = answerFor();
    input.expectedVariables = { count: 1 };
    input.answerVariables = { count: '2' };
    input.initialVariables = { count: '1' };
    input.sourceLine = 'count = count + 1;';

    expect(gradeRegularAnswers(input)).toEqual({
      status: 'incorrect',
      incorrectLocations: ['変数count'],
      hintText: `\n\nヒント: ${assignmentHint}`,
    });
  });
});
