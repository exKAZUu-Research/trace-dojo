interface PaintOptions {
  shape: string;
  xPos?: number;
  yPos?: number;
}
function paintShape({ shape, xPos = 0, yPos = 0 }: PaintOptions) {
  console.log("x coordinate at", xPos, yPos, shape);
}
paintShape({ shape: "s" });
paintShape({ shape: "s", xPos: 100 });
interface SomeType {
  readonly prop: string;
}
function doSomething(obj: SomeType) {
  console.log(`prop has the value '${obj.prop}'.`);
}
doSomething({ prop: "p" });
interface Home {
  readonly resident: { name: string; age: number };
}
function visitForBirthday(home: Home) {
  home.resident.age++;
}
const home: Home = { resident: { name: "r", age: 1 } };
visitForBirthday(home);
console.log(home);
interface StringArray {
  [index: number]: string;
}
const myArray: StringArray = ["a", "b"];
const secondItem = myArray[1];
interface NumberOrStringDictionary {
  [index: string]: number | string;
  length: number;
  name: string;
}
const dict: NumberOrStringDictionary = { length: 1, name: "n", other: 2 };
interface ReadonlyStringArray {
  readonly [index: number]: string;
}
const ro: ReadonlyStringArray = ["x"];
console.log(secondItem, dict, ro[0]);
interface SquareConfig {
  color?: string;
  width?: number;
}
function createSquare(config: SquareConfig): { color: string; area: number } {
  return { color: config.color || "red", area: config.width ? config.width * config.width : 20 };
}
const squareOptions = { colour: "red", width: 100 };
const mySquare = createSquare(squareOptions);
const mySquare2 = createSquare({ width: 100, opacity: 0.5 } as SquareConfig);
console.log(mySquare, mySquare2);
interface BasicAddress {
  name?: string;
  street: string;
}
interface AddressWithUnit extends BasicAddress {
  unit: string;
}
interface Colorful {
  color: string;
}
interface Circle {
  radius: number;
}
type ColorfulCircle = Colorful & Circle;
function draw(circle: Colorful & Circle) {
  console.log(`Color was ${circle.color}`, circle.radius);
}
draw({ color: "blue", radius: 42 });
interface Box<Type> {
  contents: Type;
}
const box: Box<string> = { contents: "hello" };
function setContents<Type>(box: Box<Type>, newContents: Type) {
  box.contents = newContents;
}
setContents(box, "world");
type OrNull<Type> = Type | null;
type OneOrMany<Type> = Type | Type[];
type OneOrManyOrNull<Type> = OrNull<OneOrMany<Type>>;
const om: OneOrManyOrNull<string> = ["a"];
function doStuff(values: ReadonlyArray<string>) {
  const copy = values.slice();
  console.log(`The first value is ${values[0]}`, copy);
}
doStuff(["z"]);
type StringNumberPair = [string, number];
function doSomething2(pair: [string, number]) {
  const a = pair[0];
  const b = pair[1];
  const [c, d] = pair;
  console.log(a, b, c, d);
}
doSomething2(["hello", 42]);
type Either2dOr3d = [number, number, number?];
function setCoordinate(coord: Either2dOr3d) {
  const [x, y, z] = coord;
  console.log(`Provided coordinates had ${coord.length} dimensions`, x, y, z);
}
setCoordinate([1, 2]);
type StringNumberBooleans = [string, number, ...boolean[]];
const a: StringNumberBooleans = ["hello", 1];
const b: StringNumberBooleans = ["beautiful", 2, true];
function readButtonInput(...args: [string, number, ...boolean[]]) {
  const [name, version, ...input] = args;
  console.log(name, version, input);
}
readButtonInput("x", 1, true);
function doSomething3(pair: readonly [string, number]) {
  console.log(pair);
}
let point = [3, 4] as const;
function distanceFromOrigin([x, y]: readonly [number, number]) {
  return Math.sqrt(x ** 2 + y ** 2);
}
console.log(distanceFromOrigin(point), om, a, b, box);
const addr: AddressWithUnit = { street: "s", unit: "u" };
const cc: ColorfulCircle = { color: "c", radius: 1 };
console.log(addr, cc);
