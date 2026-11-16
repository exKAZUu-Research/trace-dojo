function greet(name: string) {
  console.log("Hello, " + name.toUpperCase() + "!!");
}
greet(42);
function printCoord(pt: { x: number; y: number }) {}
printCoord({ x: 3 });
function printName(obj: { first: string; last?: string }) {
  console.log(obj.last.toUpperCase());
}
function printId(id: number | string) {
  console.log(id.toUpperCase());
}
let x: "hello" = "hello";
x = "howdy";
function printText(s: string, alignment: "left" | "right" | "center") {}
printText("Hello, world", "centre");
interface Options {
  width: number;
}
function configure(x: Options | "auto") {}
configure("automatic");
const req = { url: "https://example.com", method: "GET" };
function handleRequest(url: string, method: "GET" | "POST") {}
handleRequest(req.url, req.method);
const y = "hello" as number;
