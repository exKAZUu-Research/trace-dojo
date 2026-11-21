let a = [1, 2, 3];
a = ["x"];
const t: [number, string] = [1, "a", 2];
let u: undefined = null;
let n: null = undefined;
let v: void = 1;
let nv: never = 1;
const o = { a: 1 } as const;
o.a = 2;
function f(): string {
  return;
}
const fn = (x: number): string => x;
let s: string = `${1}`;
s = 5 + "";
const arr: string[] = [];
arr[0] = 1;
class C {}
const c: C = new C();
c.foo = 1;
const big: bigint = 1;
const sym: symbol = "s";
