for (let i = 1; i <= 15; i++) {
  let out = "";
  if (i % 3 === 0) out += "Fizz";
  if (i % 5 === 0) out += "Buzz";
  console.log(out || i);
}
function isPrime(n: number): boolean {
  if (n < 2) return false;
  for (let d = 2; d * d <= n; d++) if (n % d === 0) return false;
  return true;
}
const primes: number[] = [];
for (let n = 2; primes.length < 10; n++) if (isPrime(n)) primes.push(n);
console.log(primes.join(", "));
function bubbleSort(arr: number[]): number[] {
  const a = [...arr];
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < a.length - 1 - i; j++) {
      if (a[j] > a[j + 1]) {
        [a[j], a[j + 1]] = [a[j + 1], a[j]];
      }
    }
  }
  return a;
}
console.log(bubbleSort([5, 2, 9, 1, 5, 6]));
const reverse = (s: string): string => s.split("").reverse().join("");
console.log(reverse("hello"), reverse("回文"));
function countChars(s: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const ch of s) {
    counts[ch] = (counts[ch] || 0) + 1;
  }
  return counts;
}
console.log(countChars("banana"));
function fib(n: number): number {
  if (n <= 1) return n;
  return fib(n - 1) + fib(n - 2);
}
const fibs = Array.from({ length: 10 }, (_, i) => fib(i));
console.log(fibs);
let a = 1;
let b = 2;
[a, b] = [b, a];
console.log(a, b);
const matrix = [
  [1, 2, 3],
  [4, 5, 6],
];
const transposed = matrix[0].map((_, c) => matrix.map((row) => row[c]));
console.log(transposed);
const total = matrix.flat().reduce((sum, x) => sum + x, 0);
const avg = total / matrix.flat().length;
console.log(total, avg.toFixed(2), Math.round(avg * 100) / 100);
const words = ["apple", "banana", "cherry", "date"];
const lengths = words.map((w) => w.length);
const longWords = words.filter((w) => w.length > 5);
const firstWithA = words.find((w) => w.startsWith("a"));
console.log(lengths, longWords, firstWithA, words.indexOf("cherry"));
const scores = [{ name: "A", score: 80 }, { name: "B", score: 95 }, { name: "C", score: 70 }];
const sorted = [...scores].sort((x, y) => y.score - x.score);
console.log(sorted.map((s) => `${s.name}:${s.score}`).join(" "));
const best = scores.reduce((p, c) => (c.score > p.score ? c : p));
console.log(best.name);
let gcd = (x: number, y: number): number => (y === 0 ? x : gcd(y, x % y));
console.log(gcd(48, 18));
const table: string[] = [];
for (let i = 1; i <= 3; i++) {
  const row: string[] = [];
  for (let j = 1; j <= 3; j++) row.push(String(i * j).padStart(3));
  table.push(row.join(""));
}
console.log(table.join("\n"));
