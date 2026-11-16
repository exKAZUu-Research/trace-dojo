const o = { a: 1, b: 2 };
for (const k in o) console.log(o[k]);
Object.keys(o).forEach((k) => console.log(o[k]));
const n = "5" as number;
const s = 5 as unknown as string;
interface P {
  run?(): void;
}
const p: P = {};
p.run();
const list: number[] = [1, 2];
const first: number = list.find((x) => x > 1);
let later;
console.log(later.length);
function f(x: number = "1") {}
class C {
  static count = 0;
  inc() {
    this.count++;
  }
}
const arr = [1, 2, 3];
arr.push("4");
const m = new Map<string, number>();
const v: number = m.get("a");
let u: string;
u.length;
function g(a: string, b?: number, c: number) {}
const t: [number, number] = [1, 2];
const [x, y, z] = t;
