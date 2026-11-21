function add(a: number, b: number): number {
  return a + b;
}
function greet(name: string, greeting: string = "Hello", punct?: string): string {
  return `${greeting}, ${name}${punct ?? "!"}`;
}
function sum(...values: number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}
const square = (x: number): number => x * x;
const twice = function (f: (n: number) => number, x: number): number {
  return f(f(x));
};
function makeCounter(): () => number {
  let c = 0;
  return () => ++c;
}
const counter = makeCounter();
counter();
console.log(add(1, 2), greet("A"), greet("B", "Hi", "?"), sum(), sum(1, 2, 3), square(4), twice(square, 3), counter());
function log(message: string): void {
  console.log("LOG:", message);
}
log("x");
function fail(message: string): never {
  throw new Error(message);
}
type Op = (a: number, b: number) => number;
const ops: Record<string, Op> = { plus: (a, b) => a + b, times: (a, b) => a * b };
console.log(ops["plus"](2, 3), ops.times(2, 3));
function len(x: string): number;
function len(x: unknown[]): number;
function len(x: string | unknown[]): number {
  return x.length;
}
console.log(len("abc"), len([1, 2]));
function point({ x, y = 0 }: { x: number; y?: number }): string {
  return `(${x}, ${y})`;
}
console.log(point({ x: 1 }), point({ x: 2, y: 3 }));
const args = [1, 2] as const;
console.log(add(...args), Math.max(...[3, 9, 2]));
interface CallOrConstruct {
  (n?: number): string;
}
const describe: CallOrConstruct = (n) => `n=${n}`;
console.log(describe(), describe(4));
function fact(n: number): number {
  return n <= 1 ? 1 : n * fact(n - 1);
}
console.log(fact(10));
try {
  fail("stop");
} catch (e) {
  console.log(String(e));
}
const bound = function (this: { v: number }) {
  return this.v;
};
console.log(bound.call({ v: 9 }));
