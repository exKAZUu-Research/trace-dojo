function f(a: number, b: string): void {}
f(1);
f(1, "a", 2);
f("1", "a");
f(1, 2);
function g(a: number, b?: number, ...c: number[]) {}
g();
g(1, 2, 3, "4");
const notFn = 1;
notFn();
Math.max("a", 1);
