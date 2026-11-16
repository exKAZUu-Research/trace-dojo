const prices: { [item: string]: number } = { apple: 100, pear: 150 };
for (const k in prices) console.log(k, prices[k]);
Object.keys(prices).forEach((k) => console.log(k.toUpperCase()));
for (const [name, price] of Object.entries(prices)) console.log(name, price * 2);
const m = new Map<string, number[]>();
m.set("a", [1]);
m.get("a")?.push(2);
m.forEach((value, key) => console.log(key, value.length));
console.log(Array.from(m.keys()), [...m.entries()].map(([k, v]) => `${k}:${v.join("/")}`));
const evolving = [];
evolving.push(1);
evolving.push("two");
console.log(evolving);
let later;
later = 5;
console.log(later + 1);
later = "five";
console.log(later.length);
class Temperature {
  static fromFahrenheit(f: number): Temperature {
    return new Temperature(((f - 32) * 5) / 9);
  }
  constructor(readonly celsius: number) {}
  toString(): string {
    return `${this.celsius.toFixed(1)}C`;
  }
  isFreezing = (): boolean => this.celsius <= 0;
}
const t = Temperature.fromFahrenheit(212);
console.log(String(t), `${t}`, t.isFreezing(), t + "!");
interface Plugin {
  name: string;
  init?(): void;
  priority?: number;
}
const plugins: Plugin[] = [{ name: "a", init() { console.log("init a"); } }, { name: "b", priority: 2 }];
for (const p of plugins) {
  p.init?.();
  console.log(p.name, p.priority ?? 0);
}
const mixed: (string | number)[] = [1, "two", 3];
const nums = mixed.filter((x): x is number => typeof x === "number");
console.log(nums.reduce((a, b) => a + b, 0), mixed.map(String));
function minMax(values: number[]): [number, number] {
  return [Math.min(...values), Math.max(...values)];
}
const [lo, hi] = minMax([3, 9, 1]);
console.log(lo, hi);
function range(start: number, end = start + 5, step = 1): number[] {
  const out: number[] = [];
  for (let i = start; i < end; i += step) out.push(i);
  return out;
}
console.log(range(1), range(0, 10, 3));
const s = "hello";
const [first, ...restChars] = s;
console.log(first, restChars, s[0], s.at(-1));
const arr = [1, 2, 3];
arr.length = 0;
console.log(arr, Number("12") + 1, parseFloat("3.5") * 2, +"7", (1_000_000).toLocaleString());
type Animal = { kind: "dog"; bark(): string } | { kind: "cat"; meow(): string };
const pets: Animal[] = [{ kind: "dog", bark: () => "woof" }, { kind: "cat", meow: () => "meow" }];
for (const pet of pets) console.log(pet.kind === "dog" ? pet.bark() : pet.meow());
function area(shape: { w: number; h: number } | { r: number }): number {
  if ("r" in shape) return Math.PI * shape.r ** 2;
  return shape.w * shape.h;
}
console.log(area({ w: 2, h: 3 }), area({ r: 1 }).toFixed(2));
const record: Record<"x" | "y", number> = { x: 1, y: 2 };
(Object.keys(record) as ("x" | "y")[]).forEach((k) => console.log(k, record[k]));
const letters = "abc".split("").map((c, i) => c.repeat(i + 1));
console.log(letters, letters.includes("bb"), letters.some((l) => l.length > 2));
const sortedNames = ["b", "C", "a"].sort((x, y) => x.localeCompare(y));
const byLength = ["ccc", "a", "bb"].sort((x, y) => x.length - y.length || x.localeCompare(y));
console.log(sortedNames, byLength);
let counter = 0;
const inc = () => counter++;
inc();
inc();
console.log(counter);
const maybeNum: number | undefined = [5].find((n) => n > 1);
if (maybeNum !== undefined && maybeNum > 3) console.log("big", maybeNum);
const obj = { a: 1, b: "x" };
const key: keyof typeof obj = "b";
console.log(obj[key]);
