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
  | { kind: 'value'; value: number | string | boolean | null }
  | { kind: 'object' | 'array'; entries: Record<string, DisplayNode> };

export interface TraceItem {
  depth: number;
  sid: number;
  /** caller id のスタック。 `// caller` のある行に caller id が付与される。 */
  callStack: number[];
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
