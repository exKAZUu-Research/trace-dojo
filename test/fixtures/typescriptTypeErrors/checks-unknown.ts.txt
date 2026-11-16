try {
  throw new Error("x");
} catch (e) {
  console.log(e.message);
}
let v: unknown = 1;
console.log(v + 1);
v.toString();
const w: number = v;
