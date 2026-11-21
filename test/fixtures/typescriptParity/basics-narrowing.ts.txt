function pad(value: string | number): string {
  if (typeof value === "number") return " ".repeat(value);
  return value.toUpperCase();
}
console.log(pad(3) + "|", pad("ab"));
function lengthOf(x: string | string[] | null): number {
  if (!x) return 0;
  if (Array.isArray(x)) return x.length;
  return x.length;
}
console.log(lengthOf(null), lengthOf("abc"), lengthOf(["a"]));
class Fish {
  swim() {
    return "swim";
  }
}
class Bird {
  fly() {
    return "fly";
  }
}
function move(a: Fish | Bird): string {
  if (a instanceof Fish) return a.swim();
  return a.fly();
}
function isFish(a: Fish | Bird): a is Fish {
  return (a as Fish).swim !== undefined;
}
console.log(move(new Fish()), move(new Bird()), isFish(new Bird()));
type A = { a: number };
type B = { b: string };
function show(v: A | B): string {
  if ("a" in v) return `a:${v.a}`;
  return `b:${v.b}`;
}
console.log(show({ a: 1 }), show({ b: "x" }));
type Shape = { kind: "circle"; r: number } | { kind: "rect"; w: number; h: number } | { kind: "tri"; b: number; h: number };
function area(s: Shape): number {
  switch (s.kind) {
    case "circle":
      return 3 * s.r * s.r;
    case "rect":
      return s.w * s.h;
    case "tri":
      return (s.b * s.h) / 2;
    default: {
      const never: never = s;
      return never;
    }
  }
}
console.log(area({ kind: "circle", r: 2 }), area({ kind: "rect", w: 2, h: 3 }), area({ kind: "tri", b: 4, h: 2 }));
function f(x: unknown): string {
  if (typeof x === "string") return x;
  if (typeof x === "number" && x > 0) return x.toFixed(1);
  if (x === null || x === undefined) return "nothing";
  if (typeof x === "object") return "object";
  return "other";
}
console.log(f("s"), f(2), f(-1), f(null), f({}), f(undefined));
let maybe: string | undefined = [1].length > 2 ? "x" : undefined;
if (maybe !== undefined) console.log(maybe.length);
maybe = "now";
console.log(maybe.length);
const map = new Map<string, number>([["a", 1]]);
const got = map.get("a");
if (got) console.log(got + 1);
console.log(map.get("b") ?? -1);
function first(xs: number[]): number | undefined {
  return xs.length > 0 ? xs[0] : undefined;
}
const r = first([5]);
console.log(r !== undefined && r > 3);
