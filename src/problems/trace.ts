import type { CellColor, ColorChar } from '@/types';

export interface TurtleTrace {
  x: number;
  y: number;
  /** 色を表現する1文字 */
  color: string;
  /** 方向を表現する1文字 */
  dir: string;
}

export type DisplayNode =
  /** A value; `verbatim` text, such as a BigInt's digits or a symbol's description, is shown without quotes. */
  | { kind: 'value'; value: number | string | boolean | null; verbatim?: true }
  | { kind: 'object' | 'array'; entries: Record<string, DisplayNode> };

export interface TraceItem {
  /** The 1-based line of the statement that has just run, or 0 for the state before the program runs. */
  line: number;
  /** The 1-based lines of the calls in progress, outermost first. */
  callLines: number[];
  vars: TraceItemVariable;
  referenceVars: Record<string, DisplayNode>;
  turtles: TurtleTrace[];
  board: string;
}

export type TraceScalar = number | string | boolean | null;
export type TraceArray = (TraceScalar | TraceArray)[];
export type TraceItemVariable = Record<string, TraceScalar | TraceArray>;

export const charToColor = {
  '#': 'black',
  '.': 'white',
  R: 'red',
  G: 'green',
  B: 'blue',
  Y: 'yellow',
  P: 'purple',
} as const;

export const colorToChar = Object.fromEntries(
  Object.entries(charToColor).map(([char, color]) => [color, char])
) as Record<CellColor, ColorChar>;
