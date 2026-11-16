interface Pt { x: number; y: number }
const a: Pt = { x: 1 };
const b: Pt = { x: 1, y: 2, z: 3 };
function f(p: Pt) {}
f({ x: 1, y: 2, w: 1 });
const c: { readonly r: number } = { r: 1 };
c.r = 2;
const d: Record<string, number> = { a: "x" };
const tup: readonly [number, number] = [1, 2];
tup[0] = 3;
const ra: readonly number[] = [1];
ra.push(2);
