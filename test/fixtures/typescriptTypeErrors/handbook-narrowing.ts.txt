function printAll(strs: string | string[] | null) {
  if (typeof strs === "object") {
    for (const s of strs) {
      console.log(s);
    }
  }
}
function getArea(shape: { kind: "circle"; radius: number } | { kind: "square"; sideLength: number }) {
  if (shape.kind === "circle") {
    return Math.PI * shape.sideLength;
  }
}
type Shape = { kind: "circle"; radius: number } | { kind: "square"; sideLength: number } | { kind: "triangle"; sideLength: number };
function getArea2(shape: Shape) {
  switch (shape.kind) {
    case "circle":
      return 1;
    case "square":
      return 2;
    default:
      const _exhaustiveCheck: never = shape;
      return _exhaustiveCheck;
  }
}
let x = Math.max(1) < 0.5 ? 10 : "hello world!";
x = true;
