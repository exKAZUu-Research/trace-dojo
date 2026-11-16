function firstElement<Type>(arr: Type[]): Type {
  return arr[0];
}
function minimumLength<Type extends { length: number }>(obj: Type, minimum: number): Type {
  if (obj.length >= minimum) {
    return obj;
  } else {
    return { length: minimum };
  }
}
function combine<Type>(arr1: Type[], arr2: Type[]): Type[] {
  return arr1.concat(arr2);
}
const arr = combine([1, 2, 3], ["hello"]);
function longest<Type extends { length: number }>(a: Type, b: Type) {
  return a;
}
const notOK = longest(10, 100);
function len(s: string): number;
function len(arr: any[]): number;
function len(x: any) {
  return x.length;
}
len(Math.max(1) > 0.5 ? "hello" : [0]);
function f(...args: number[]) {}
const args = [8, 5];
const angle = Math.atan2(...args);
function doSomething(f: Function) {
  return f(1, 2, 3);
}
function safeParse(s: string): unknown {
  return JSON.parse(s);
}
const obj = safeParse("1");
obj.x;
