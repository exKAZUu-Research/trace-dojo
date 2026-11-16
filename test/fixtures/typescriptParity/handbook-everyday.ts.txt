let myName: string = "Alice";
let obj: any = { x: 0 };
try {
  obj.foo();
} catch (e) {
  console.log("caught:", (e as Error).message);
}
function greet(name: string): void {
  console.log("Hello, " + name.toUpperCase() + "!!");
}
greet(myName);
function getFavoriteNumber(): number {
  return 26;
}
const names = ["Alice", "Bob", "Eve"];
names.forEach(function (s) {
  console.log(s.toUpperCase());
});
names.forEach((s) => {
  console.log(s.toUpperCase());
});
function printCoord(pt: { x: number; y: number }) {
  console.log("The coordinate's x value is " + pt.x);
}
printCoord({ x: 3, y: 7 });
function printName(obj: { first: string; last?: string }) {
  if (obj.last !== undefined) console.log(obj.last.toUpperCase());
  console.log(obj.last?.toUpperCase());
}
printName({ first: "Bob" });
printName({ first: "Alice", last: "Alisson" });
function printId(id: number | string) {
  if (typeof id === "string") {
    console.log(id.toUpperCase());
  } else {
    console.log(id);
  }
}
printId(101);
printId("202");
function welcomePeople(x: string[] | string) {
  if (Array.isArray(x)) {
    console.log("Hello, " + x.join(" and "));
  } else {
    console.log("Welcome lone traveler " + x);
  }
}
welcomePeople(["a", "b"]);
function getFirstThree(x: number[] | string) {
  return x.slice(0, 3);
}
console.log(getFirstThree("abcdef"), getFavoriteNumber());
type Point = { x: number; y: number };
interface Animal {
  name: string;
}
interface Bear extends Animal {
  honey: boolean;
}
const bear: Bear = { name: "b", honey: true };
type Animal2 = { name: string };
type Bear2 = Animal2 & { honey: boolean };
const bear2: Bear2 = { name: "c", honey: false };
console.log(bear.name, bear2.honey);
const x = "hello" as unknown as number;
let changingString = "Hello World";
changingString = "Olá Mundo";
const constantString = "Hello World";
let xx: "hello" = "hello";
function printText(s: string, alignment: "left" | "right" | "center") {
  console.log(s, alignment);
}
printText("Hello, world", "left");
function compare(a: string, b: string): -1 | 0 | 1 {
  return a === b ? 0 : a > b ? 1 : -1;
}
interface Options {
  width: number;
}
function configure(x: Options | "auto") {
  console.log(x);
}
configure({ width: 100 });
configure("auto");
const req = { url: "https://example.com", method: "GET" as "GET" };
function handleRequest(url: string, method: "GET" | "POST") {
  console.log(url, method);
}
handleRequest(req.url, req.method);
const req2 = { url: "https://example.com", method: "GET" } as const;
handleRequest(req2.url, req2.method);
function doSomething(x: string | null) {
  if (x === null) {
  } else {
    console.log("Hello, " + x.toUpperCase());
  }
}
function liveDangerously(x?: number | null) {
  console.log(x!.toFixed());
}
liveDangerously(1);
const oneHundred: bigint = BigInt(100);
const anotherHundred: bigint = 100n;
const firstName = Symbol("name");
const secondName = Symbol("name");
console.log(compare("a", "b"), oneHundred === anotherHundred, typeof firstName, x, changingString, constantString, xx);
