function f(x: string | number) {
  return x.toUpperCase();
}
function g(x: string | number) {
  if (typeof x === "string") {
    return x.toFixed();
  }
  return x.toFixed();
}
type S = { kind: "a"; a: number } | { kind: "b"; b: string };
function h(s: S) {
  if (s.kind === "a") return s.b;
  return s.b;
}
function k(x: "a" | "b") {
  if (x === "c") return 1;
}
