interface SomeType {
  readonly prop: string;
}
function doSomething(obj: SomeType) {
  obj.prop = "hello";
}
interface NumberDictionary {
  [index: string]: number;
  length: number;
  name: string;
}
interface ReadonlyStringArray {
  readonly [index: number]: string;
}
let myArray: ReadonlyStringArray = ["a"];
myArray[2] = "Mallory";
interface SquareConfig {
  color?: string;
  width?: number;
}
function createSquare(config: SquareConfig) {}
createSquare({ colour: "red", width: 100 });
const opts = { colour: "red" };
createSquare(opts);
function doStuff(values: readonly string[]) {
  values.push("hello!");
}
function doSomething2(pair: [string, number]) {
  const c = pair[2];
}
let point = [3, 4] as const;
function distanceFromOrigin([x, y]: [number, number]) {}
distanceFromOrigin(point);
let x: readonly string[] = [];
let y: string[] = [];
y = x;
