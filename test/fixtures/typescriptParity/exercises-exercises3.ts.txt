type Result<T> = { ok: true; value: T } | { ok: false; error: string };
function parseNumber(s: string): Result<number> {
  const n = Number(s);
  if (Number.isNaN(n)) return { ok: false, error: `not a number: ${s}` };
  return { ok: true, value: n };
}
for (const input of ["42", "x"]) {
  const r = parseNumber(input);
  if (r.ok) console.log(r.value * 2);
  else console.log(r.error);
}
function describe(x: string | number | boolean | null | undefined): string {
  if (x === null) return "null";
  if (x === undefined) return "undefined";
  switch (typeof x) {
    case "string":
      return `string(${x.length})`;
    case "number":
      return `number(${x.toFixed(1)})`;
    default:
      return `boolean(${x})`;
  }
}
console.log([1, "ab", true, null, undefined].map((v) => describe(v)));
interface Student {
  name: string;
  grades: number[];
}
const students: Student[] = [
  { name: "Ann", grades: [90, 80] },
  { name: "Ben", grades: [70, 60, 50] },
];
const averages = students.map(({ name, grades }) => ({
  name,
  avg: grades.reduce((a, b) => a + b, 0) / grades.length,
}));
console.log(averages);
const byName = Object.fromEntries(students.map((s) => [s.name, s.grades.length]));
console.log(byName);
function makeMultiplier(k: number) {
  return (x: number) => x * k;
}
const triple = makeMultiplier(3);
console.log(triple(5), [1, 2, 3].map(makeMultiplier(10)));
const counter = (() => {
  let count = 0;
  return {
    inc: () => ++count,
    get value() {
      return count;
    },
  };
})();
counter.inc();
counter.inc();
console.log(counter.value);
let maybeName: string | undefined;
const greetings = ["hi", "hello"];
maybeName = greetings.find((g) => g.length > 3);
console.log(maybeName?.toUpperCase() ?? "none");
const nested = { a: { b: { c: 1 } } } as { a?: { b?: { c?: number } } };
console.log(nested.a?.b?.c ?? 0);
function sumAll(...nums: number[]): number {
  return nums.reduce((t, n) => t + n, 0);
}
const values = [1, 2, 3];
console.log(sumAll(...values), sumAll());
const dateLike = { y: 2024, m: 1, d: 5 };
const { y, m: month, ...restDate } = dateLike;
console.log(y, month, restDate);
const grid: string[][] = Array.from({ length: 3 }, () => Array<string>(3).fill("."));
grid[1][1] = "#";
console.log(grid.map((r) => r.join("")).join("\n"));
const temps = [22.5, 19.0, 24.3];
const max = Math.max(...temps);
const min = Math.min(...temps);
console.log(`max=${max} min=${min} range=${(max - min).toFixed(1)}`);
let text = "The quick brown fox";
const vowels = text.match(/[aeiou]/gi)?.length ?? 0;
console.log(vowels, text.toLowerCase().split(" ").map((w) => w[0]).join(""));
const people: Array<{ name: string; age: number }> = [];
people.push({ name: "X", age: 20 });
const adults = people.filter((p) => p.age >= 18).map((p) => p.name);
console.log(adults);
function assertPositive(n: number): number {
  if (n <= 0) {
    throw new RangeError(`must be positive: ${n}`);
  }
  return n;
}
try {
  assertPositive(-5);
} catch (err) {
  if (err instanceof RangeError) console.log("RangeError:", err.message);
  else throw err;
} finally {
  console.log("done");
}
