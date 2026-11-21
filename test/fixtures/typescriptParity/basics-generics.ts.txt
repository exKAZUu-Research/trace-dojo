function identity<T>(x: T): T {
  return x;
}
const n = identity(5);
const s = identity<string>("s");
console.log(n, s);
function firstOf<T>(xs: T[]): T | undefined {
  return xs[0];
}
console.log(firstOf([3, 4]), firstOf<string>([]));
function longest<T extends { length: number }>(a: T, b: T): T {
  return a.length >= b.length ? a : b;
}
console.log(longest("ab", "c"), longest([1, 2], [3]));
function getProp<T, K extends keyof T>(obj: T, key: K): T[K] {
  return obj[key];
}
const person = { name: "Ann", age: 30 };
console.log(getProp(person, "name"), getProp(person, "age"));
function mapArray<T, U>(xs: T[], f: (x: T) => U): U[] {
  return xs.map(f);
}
console.log(mapArray([1, 2], (x) => x.toString() + "!"));
interface Pair<A, B> {
  first: A;
  second: B;
}
const pair: Pair<number, string> = { first: 1, second: "two" };
console.log(pair);
class Stack<T> {
  private data: T[] = [];
  push(x: T): void {
    this.data.push(x);
  }
  pop(): T | undefined {
    return this.data.pop();
  }
}
const st = new Stack<number>();
st.push(1);
st.push(2);
console.log(st.pop(), st.pop(), st.pop());
type Wrapper<T = string> = { value: T };
const w: Wrapper = { value: "default" };
const w2: Wrapper<number> = { value: 2 };
console.log(w, w2);
function merge<A extends object, B extends object>(a: A, b: B): A & B {
  return { ...a, ...b };
}
const mm = merge({ x: 1 }, { y: "y" });
console.log(mm.x, mm.y);
const nums = [3, 1, 2].filter((x) => x > 1).map((x) => x * 10).reduce((a, b) => a + b, 0);
console.log(nums);
