function id<T>(x: T): T {
  return x;
}
const n: string = id(1);
function len<T extends { length: number }>(x: T) {
  return x.length;
}
len(1);
const m = new Map<string, number>();
m.set(1, "a");
const s = new Set<number>([1, "a"]);
type P<T extends string> = { v: T };
const p: P<number> = { v: 1 };
let arr: Array<number, string>;
