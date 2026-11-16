function f(s: string | undefined) {
  return s.length;
}
function g(s: string | null) {
  return s.toUpperCase();
}
const m = new Map<string, number>();
console.log(m.get("a") + 1);
const arr: number[] = [];
const found = arr.find((x) => x > 1);
console.log(found.toFixed());
let maybe: { v: number } | null = null;
console.log(maybe.v);
