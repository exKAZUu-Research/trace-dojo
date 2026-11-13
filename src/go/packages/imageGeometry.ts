import { addMethod, fn, namedType } from '../native';
import { divideByZeroPanic } from '../runtimeErrors';
import { BASIC } from '../types';
import { copyValue, GoStruct, Iface, type Value } from '../values';
import { ALPHA16, ALPHA16_MODEL, COLOR, MODEL, OPAQUE, RGBA64, TRANSPARENT } from './imageColor';
import { INT, STRING } from './support';

export const i64 = (value: bigint): bigint => BigInt.asIntN(64, value);

export const POINT = namedType('image', 'Point', {
  kind: 'struct',
  fields: [
    { name: 'X', type: INT, embedded: false },
    { name: 'Y', type: INT, embedded: false },
  ],
});
export const RECTANGLE = namedType('image', 'Rectangle', {
  kind: 'struct',
  fields: [
    { name: 'Min', type: POINT, embedded: false },
    { name: 'Max', type: POINT, embedded: false },
  ],
});

addMethod(POINT, 'String', fn([], [STRING]), (receiver) => pointText(coordinates(receiver)));
addMethod(POINT, 'Add', fn([POINT], [POINT]), (receiver, [other]) => {
  const [x, y] = coordinates(receiver);
  const [dx, dy] = coordinates(other);
  return point(i64(x + dx), i64(y + dy));
});
addMethod(POINT, 'Sub', fn([POINT], [POINT]), (receiver, [other]) => {
  const [x, y] = coordinates(receiver);
  const [dx, dy] = coordinates(other);
  return point(i64(x - dx), i64(y - dy));
});
addMethod(POINT, 'Mul', fn([INT], [POINT]), (receiver, [k]) => {
  const [x, y] = coordinates(receiver);
  return point(i64(x * (k as bigint)), i64(y * (k as bigint)));
});
addMethod(POINT, 'Div', fn([INT], [POINT]), (receiver, [k]) => {
  const [x, y] = coordinates(receiver);
  return point(divide(x, k as bigint), divide(y, k as bigint));
});
addMethod(POINT, 'In', fn([RECTANGLE], [BASIC.bool]), (receiver, [bounds]) => {
  const [x, y] = coordinates(receiver);
  return contains(edges(bounds), x, y);
});
addMethod(POINT, 'Mod', fn([RECTANGLE], [POINT]), (receiver, [bounds]) => {
  const [x, y] = coordinates(receiver);
  const [x0, y0, x1, y1] = edges(bounds);
  return point(i64(wrap(i64(x - x0), i64(x1 - x0)) + x0), i64(wrap(i64(y - y0), i64(y1 - y0)) + y0));
});
addMethod(POINT, 'Eq', fn([POINT], [BASIC.bool]), (receiver, [other]) => {
  const [x, y] = coordinates(receiver);
  const [ox, oy] = coordinates(other);
  return x === ox && y === oy;
});

addMethod(RECTANGLE, 'String', fn([], [STRING]), (receiver) => {
  const [x0, y0, x1, y1] = edges(receiver);
  return `${pointText([x0, y0])}-${pointText([x1, y1])}`;
});
addMethod(RECTANGLE, 'Dx', fn([], [INT]), (receiver) => width(edges(receiver)));
addMethod(RECTANGLE, 'Dy', fn([], [INT]), (receiver) => height(edges(receiver)));
addMethod(RECTANGLE, 'Size', fn([], [POINT]), (receiver) => {
  const bounds = edges(receiver);
  return point(width(bounds), height(bounds));
});
addMethod(RECTANGLE, 'Add', fn([POINT], [RECTANGLE]), (receiver, [offset]) => {
  const [x0, y0, x1, y1] = edges(receiver);
  const [dx, dy] = coordinates(offset);
  return rectangle([i64(x0 + dx), i64(y0 + dy), i64(x1 + dx), i64(y1 + dy)]);
});
addMethod(RECTANGLE, 'Sub', fn([POINT], [RECTANGLE]), (receiver, [offset]) => {
  const [x0, y0, x1, y1] = edges(receiver);
  const [dx, dy] = coordinates(offset);
  return rectangle([i64(x0 - dx), i64(y0 - dy), i64(x1 - dx), i64(y1 - dy)]);
});
addMethod(RECTANGLE, 'Inset', fn([INT], [RECTANGLE]), (receiver, [n]) => {
  const [x0, y0, x1, y1] = edges(receiver);
  const [minX, maxX] = inset(x0, x1, n as bigint);
  const [minY, maxY] = inset(y0, y1, n as bigint);
  return rectangle([minX, minY, maxX, maxY]);
});
addMethod(RECTANGLE, 'Intersect', fn([RECTANGLE], [RECTANGLE]), (receiver, [other]) =>
  rectangle(intersect(edges(receiver), edges(other)))
);
addMethod(RECTANGLE, 'Union', fn([RECTANGLE], [RECTANGLE]), (receiver, [other]) => {
  const bounds = edges(receiver);
  const others = edges(other);
  if (isEmpty(bounds)) return rectangle(others);
  if (isEmpty(others)) return rectangle(bounds);
  const [x0, y0, x1, y1] = bounds;
  const [ox0, oy0, ox1, oy1] = others;
  return rectangle([min(x0, ox0), min(y0, oy0), max(x1, ox1), max(y1, oy1)]);
});
addMethod(RECTANGLE, 'Empty', fn([], [BASIC.bool]), (receiver) => isEmpty(edges(receiver)));
addMethod(RECTANGLE, 'Eq', fn([RECTANGLE], [BASIC.bool]), (receiver, [other]) => {
  const bounds = edges(receiver);
  const others = edges(other);
  return bounds.every((edge, index) => edge === others[index]) || (isEmpty(bounds) && isEmpty(others));
});
addMethod(RECTANGLE, 'Overlaps', fn([RECTANGLE], [BASIC.bool]), (receiver, [other]) => {
  const bounds = edges(receiver);
  const others = edges(other);
  const [x0, y0, x1, y1] = bounds;
  const [ox0, oy0, ox1, oy1] = others;
  return !isEmpty(bounds) && !isEmpty(others) && x0 < ox1 && ox0 < x1 && y0 < oy1 && oy0 < y1;
});
addMethod(RECTANGLE, 'In', fn([RECTANGLE], [BASIC.bool]), (receiver, [other]) => {
  const bounds = edges(receiver);
  const [x0, y0, x1, y1] = bounds;
  const [ox0, oy0, ox1, oy1] = edges(other);
  return isEmpty(bounds) || (ox0 <= x0 && x1 <= ox1 && oy0 <= y0 && y1 <= oy1);
});
addMethod(RECTANGLE, 'Canon', fn([], [RECTANGLE]), (receiver) => rectangle(canonical(edges(receiver))));
addMethod(RECTANGLE, 'At', fn([INT, INT], [COLOR]), (receiver, [x, y]) =>
  contains(edges(receiver), x as bigint, y as bigint)
    ? new Iface(ALPHA16, copyValue(OPAQUE))
    : new Iface(ALPHA16, copyValue(TRANSPARENT))
);
addMethod(RECTANGLE, 'RGBA64At', fn([INT, INT], [RGBA64]), (receiver, [x, y]) => {
  const channel = contains(edges(receiver), x as bigint, y as bigint) ? 0xff_ffn : 0n;
  return new GoStruct([channel, channel, channel, channel]);
});
addMethod(RECTANGLE, 'Bounds', fn([], [RECTANGLE]), (receiver) => copyValue(receiver));
addMethod(RECTANGLE, 'ColorModel', fn([], [MODEL]), () => ALPHA16_MODEL);

export function point(x: bigint, y: bigint): GoStruct {
  return new GoStruct([x, y]);
}

export function coordinates(value: Value): bigint[] {
  return (value as GoStruct).fields as bigint[];
}

function pointText([x, y]: bigint[]): string {
  return `(${x},${y})`;
}

function divide(dividend: bigint, divisor: bigint): bigint {
  if (divisor === 0n) divideByZeroPanic();
  return i64(dividend / divisor);
}

/** `offset % size` moved into `[0, size)`, as `Point.Mod` computes each coordinate. */
function wrap(offset: bigint, size: bigint): bigint {
  if (size === 0n) divideByZeroPanic();
  const remainder = offset % size;
  return remainder < 0n ? i64(remainder + size) : remainder;
}

/** A rectangle's coordinates as `[Min.X, Min.Y, Max.X, Max.Y]`. */
export function edges(value: Value): bigint[] {
  const [min, max] = (value as GoStruct).fields;
  return [...coordinates(min), ...coordinates(max)];
}

export function rectangle([x0, y0, x1, y1]: bigint[]): GoStruct {
  return new GoStruct([point(x0, y0), point(x1, y1)]);
}

export function width([x0, , x1]: bigint[]): bigint {
  return i64(x1 - x0);
}

export function height([, y0, , y1]: bigint[]): bigint {
  return i64(y1 - y0);
}

export function isEmpty([x0, y0, x1, y1]: bigint[]): boolean {
  return x0 >= x1 || y0 >= y1;
}

export function contains([x0, y0, x1, y1]: bigint[], x: bigint, y: bigint): boolean {
  return x0 <= x && x < x1 && y0 <= y && y < y1;
}

function inset(low: bigint, high: bigint, n: bigint): [bigint, bigint] {
  if (i64(high - low) < i64(2n * n)) {
    const middle = i64(low + high) / 2n;
    return [middle, middle];
  }
  return [i64(low + n), i64(high - n)];
}

export function intersect(bounds: bigint[], others: bigint[]): bigint[] {
  const [x0, y0, x1, y1] = bounds;
  const [ox0, oy0, ox1, oy1] = others;
  const result = [max(x0, ox0), max(y0, oy0), min(x1, ox1), min(y1, oy1)];
  return isEmpty(result) ? [0n, 0n, 0n, 0n] : result;
}

export function canonical([x0, y0, x1, y1]: bigint[]): bigint[] {
  return [min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)];
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
