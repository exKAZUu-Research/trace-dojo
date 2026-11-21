function check(n: number): number {
  if (n < 0) throw new RangeError(`negative: ${n}`);
  return n;
}
try {
  check(-1);
} catch (e) {
  if (e instanceof RangeError) console.log("range", e.message, e.name);
}
try {
  null!.toString();
} catch (e) {
  console.log((e as Error).message);
}
try {
  const o: any = undefined;
  o.x;
} catch (e) {
  console.log(String(e));
}
try {
  JSON.parse("{bad");
} catch (e) {
  console.log(e instanceof SyntaxError, (e as Error).message);
}
try {
  [].reduce((a: number, b: number) => a + b);
} catch (e) {
  console.log((e as Error).message);
}
try {
  new Array(-1);
} catch (e) {
  console.log((e as Error).name);
}
class AppError extends Error {
  constructor(public code: number) {
    super(`code ${code}`);
    this.name = "AppError";
  }
}
const err = new AppError(7);
console.log(err.message, err.code, err instanceof AppError, err.name);
function deep(n: number): number {
  return n === 0 ? 0 : 1 + deep(n - 1);
}
console.log(deep(1000));
throw new AppError(42);
