function f(x: number) {
  if (x > 0) return 1;
  if (x < 0) return "n";
}
const r: number | string | undefined = f(1);
console.log(r);
