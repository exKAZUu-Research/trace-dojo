function padLeft(padding: number | string, input: string): string {
  if (typeof padding === "number") {
    return " ".repeat(padding) + input;
  }
  return padding + input;
}
console.log(padLeft(2, "x"), padLeft(">", "y"));
function printAll(strs: string | string[] | null) {
  if (strs && typeof strs === "object") {
    for (const s of strs) {
      console.log(s);
    }
  } else if (typeof strs === "string") {
    console.log(strs);
  }
}
printAll(["a", "b"]);
printAll(null);
function multiplyAll(values: number[] | undefined, factor: number): number[] | undefined {
  if (!values) {
    return values;
  } else {
    return values.map((x) => x * factor);
  }
}
console.log(multiplyAll([1, 2], 3), multiplyAll(undefined, 2));
function example(x: string | number, y: string | boolean) {
  if (x === y) {
    x.toUpperCase();
    y.toLowerCase();
  } else {
    console.log(x);
    console.log(y);
  }
}
example(1, true);
interface Container {
  value: number | null | undefined;
}
function multiplyValue(container: Container, factor: number) {
  if (container.value != null) {
    console.log(container.value);
    container.value *= factor;
  }
}
multiplyValue({ value: 5 }, 2);
type Fish = { swim: () => void };
type Bird = { fly: () => void };
type Human = { swim?: () => void; fly?: () => void };
function move(animal: Fish | Bird | Human) {
  if ("swim" in animal) {
    animal;
  } else {
    animal;
  }
}
function logValue(x: RegExp | string) {
  if (x instanceof RegExp) {
    console.log(x.source);
  } else {
    console.log(x.toUpperCase());
  }
}
logValue("s");
let x = Math.max(0, 1) < 0.5 ? 10 : "hello world!";
x = 1;
console.log(x);
x = "goodbye!";
console.log(x);
function exampleFlow() {
  let x: string | number | boolean;
  x = Math.max(1) < 0.5;
  console.log(x);
  if (Math.max(1) < 0.5) {
    x = "hello";
    console.log(x);
  } else {
    x = 100;
    console.log(x);
  }
  return x;
}
console.log(exampleFlow());
function isFish(pet: Fish | Bird): pet is Fish {
  return (pet as Fish).swim !== undefined;
}
const zoo: (Fish | Bird)[] = [{ swim() { console.log("swim"); } }, { fly() { console.log("fly"); } }];
const underWater1: Fish[] = zoo.filter(isFish);
const underWater2: Fish[] = zoo.filter(isFish) as Fish[];
const underWater3: Fish[] = zoo.filter((pet): pet is Fish => {
  if ((pet as Bird).fly !== undefined) return false;
  return isFish(pet);
});
console.log(underWater1.length, underWater2.length, underWater3.length);
interface Circle {
  kind: "circle";
  radius: number;
}
interface Square {
  kind: "square";
  sideLength: number;
}
type Shape = Circle | Square;
function getArea(shape: Shape) {
  switch (shape.kind) {
    case "circle":
      return Math.PI * shape.radius ** 2;
    case "square":
      return shape.sideLength ** 2;
    default:
      const _exhaustiveCheck: never = shape;
      return _exhaustiveCheck;
  }
}
console.log(getArea({ kind: "square", sideLength: 3 }).toFixed(1));
function f(value: unknown) {
  if (Array.isArray(value)) return value.length;
  if (typeof value === "function") return "fn";
  return typeof value;
}
console.log(f([1]), f(() => 1), f(3));
