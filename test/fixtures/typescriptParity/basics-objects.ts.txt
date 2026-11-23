interface Point {
  readonly x: number;
  y: number;
  label?: string;
}
type Point3 = Point & { z: number };
const p: Point = { x: 1, y: 2 };
const q: Point3 = { x: 1, y: 2, z: 3, label: "q" };
p.y = 5;
console.log(p, q, p.label?.toUpperCase(), q.label?.toUpperCase());
interface StringMap {
  [key: string]: number;
}
const m: StringMap = {};
m["a"] = 1;
m.b = 2;
console.log(m, Object.keys(m), Object.values(m), Object.entries(m));
const { x, y: why, ...rest } = q;
console.log(x, why, rest);
const [first, , third = 9, ...others] = [1, 2, undefined, 4, 5];
console.log(first, third, others);
const nested = { a: { b: { c: [1, { d: "deep" }] } }, list: [[1, 2], [3]], fn() { return 1; } };
console.log(nested, JSON.stringify(nested));
const merged = { ...p, extra: true };
console.log(merged);
const key = "dyn";
const withComputed = { [key]: 1, [`${key}2`]: 2 };
console.log(withComputed);
type Shape = { kind: "circle"; radius: number } | { kind: "square"; side: number };
function area(s: Shape): number {
  if (s.kind === "circle") return Math.PI * s.radius ** 2;
  return s.side * s.side;
}
console.log(area({ kind: "circle", radius: 1 }), area({ kind: "square", side: 2 }));
const arr: readonly number[] = [3, 1, 2];
console.log(arr.slice().sort(), arr);
const tuple: [string, number, boolean?] = ["a", 1];
console.log(tuple, tuple.length);
const counter = {
  count: 0,
  increment() {
    this.count++;
    return this.count;
  },
  get double() {
    return this.count * 2;
  },
};
counter.increment();
console.log(counter.count, counter.double, counter);
