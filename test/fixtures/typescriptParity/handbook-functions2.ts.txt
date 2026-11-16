function greeter(fn: (a: string) => void) {
  fn("Hello, World");
}
function printToConsole(s: string) {
  console.log(s);
}
greeter(printToConsole);
type GreetFunction = (a: string) => void;
function greeter2(fn: GreetFunction) {
  fn("hi");
}
greeter2((s) => console.log(s.length));
type DescribableFunction = {
  description: string;
  (someArg: number): boolean;
};
function doSomething(fn: DescribableFunction) {
  console.log(fn.description + " returned " + fn(6));
}
function myFunc(someArg: number) {
  return someArg > 3;
}
myFunc.description = "default description";
doSomething(myFunc);
type SomeConstructor = {
  new (s: string): { s: string };
};
class Thing {
  constructor(public s: string) {}
}
function fn(ctor: SomeConstructor) {
  return new ctor("hello");
}
console.log(fn(Thing).s);
function firstElement<Type>(arr: Type[]): Type | undefined {
  return arr[0];
}
const s = firstElement(["a", "b", "c"]);
const n = firstElement([1, 2, 3]);
const u = firstElement([]);
console.log(s, n, u);
function map<Input, Output>(arr: Input[], func: (arg: Input) => Output): Output[] {
  return arr.map(func);
}
const parsed = map(["1", "2", "3"], (n) => parseInt(n));
console.log(parsed);
function longest<Type extends { length: number }>(a: Type, b: Type) {
  if (a.length >= b.length) {
    return a;
  } else {
    return b;
  }
}
const longerArray = longest([1, 2], [1, 2, 3]);
const longerString = longest("alice", "bob");
console.log(longerArray, longerString);
function combine<Type>(arr1: Type[], arr2: Type[]): Type[] {
  return arr1.concat(arr2);
}
const arr = combine<string | number>([1, 2, 3], ["hello"]);
console.log(arr);
function f(x?: number) {
  return x ?? 0;
}
console.log(f(), f(10));
function myForEach(arr: any[], callback: (arg: any, index?: number) => void) {
  for (let i = 0; i < arr.length; i++) {
    callback(arr[i], i);
  }
}
myForEach([1, 2, 3], (a, i) => console.log(a, i));
function makeDate(timestamp: number): string;
function makeDate(m: number, d: number, y: number): string;
function makeDate(mOrTimestamp: number, d?: number, y?: number): string {
  if (d !== undefined && y !== undefined) {
    return `${y}-${mOrTimestamp}-${d}`;
  } else {
    return `ts${mOrTimestamp}`;
  }
}
console.log(makeDate(12345678), makeDate(5, 5, 5));
interface User {
  admin: boolean;
}
interface DB {
  filterUsers(filter: (this: User) => boolean): User[];
}
const db: DB = {
  filterUsers(filter) {
    return [{ admin: true }, { admin: false }].filter((u) => filter.call(u));
  },
};
const admins = db.filterUsers(function (this: User) {
  return this.admin;
});
console.log(admins);
function noop() {
  return;
}
function fail(msg: string): never {
  throw new Error(msg);
}
function multiply(n: number, ...m: number[]) {
  return m.map((x) => n * x);
}
const a = multiply(10, 1, 2, 3, 4);
const arr1 = [1, 2, 3];
const arr2 = [4, 5, 6];
arr1.push(...arr2);
const args = [8, 5] as const;
const angle = Math.atan2(...args);
function sum({ a, b, c }: { a: number; b: number; c: number }) {
  console.log(a + b + c);
}
sum({ a: 10, b: 3, c: 9 });
type voidFunc = () => void;
const f1: voidFunc = () => {
  return true;
};
const v1 = f1();
console.log(noop(), a, arr1, angle.toFixed(3), v1);
const src = [1, 2, 3];
const dst = [0];
src.forEach((el) => dst.push(el));
console.log(dst);
