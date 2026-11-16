function a(x: number): number {
  if (x > 0) return 1;
}
function b(): string {}
function c(x: number): string {
  return x;
}
function d(): void {
  return 1;
}
function e(x: number): number | undefined {
  if (x > 0) return 1;
}
function f(x: boolean): number {
  if (x) {
    return 1;
  } else {
    return 2;
  }
}
function g(): never {
  console.log();
}
