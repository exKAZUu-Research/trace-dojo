const a = [5, 3, 8, 1];
console.log(a.length, a.indexOf(8), a.includes(3), a.at(-1), a.find((x) => x > 4), a.findIndex((x) => x > 4), a.findLast((x) => x > 4), a.findLastIndex((x) => x < 0));
console.log(a.slice(1, 3), a.concat([9], 10), a.join("-"), a.toString(), [...a].reverse(), a.some((x) => x > 7), a.every((x) => x > 0));
const b = [...a];
b.push(4, 6);
b.unshift(0);
console.log(b.pop(), b.shift(), b, b.splice(1, 2), b, b.splice(1, 0, 99, 98), b);
console.log([3, 10, 2].sort(), [3, 10, 2].sort((x, y) => x - y), ["b", "a", "C"].sort(), [3, 1, 2].toSorted(), a.toReversed(), a.with(0, 100));
console.log(a.map((x, i) => x * i), a.filter((x) => x % 2 === 1), a.reduce((s, x) => s + x, 0), a.reduceRight((s, x) => s + String(x), ""));
console.log([[1, 2], [3, [4]]].flat(), [[1, 2], [3, [4]]].flat(2), [1, 2].flatMap((x) => [x, x * 10]), new Array(3).fill(0), Array.from({ length: 3 }, (_, i) => i * i));
console.log(Array.of(1, 2), Array.isArray([]), Array.isArray("a"), [..."ab"].entries().next(), [...[7, 8].entries()], [...[7, 8].keys()], [...[7, 8].values()]);
a.forEach((x, i) => {
  if (i < 2) console.log("each", x, i);
});
for (const [i, x] of a.entries()) if (i === 0) console.log(i, x);
const grid: number[][] = [];
for (let r = 0; r < 2; r++) {
  grid.push([]);
  for (let c = 0; c < 3; c++) grid[r].push(r * 3 + c);
}
console.log(grid, grid.length, grid[1][2]);
const people = [{ name: "B", age: 30 }, { name: "A", age: 25 }];
people.sort((p, q) => p.name.localeCompare(q.name));
console.log(people, people.map((p) => p.age).join(), Math.max(...people.map((p) => p.age)));
const sparse = [1, , 3];
console.log(sparse, sparse.length, new Array(5), [undefined, null], [1, [2, [3, [4, [5]]]]]);
console.log(Array(101).fill(1).length, Array.from({ length: 101 }, (_, i) => i));
console.log(["x", "y"].indexOf("z"), [1, 2, 3].lastIndexOf(3), [1, 2, 3].fill(0, 1), [1, 2, 3, 4].copyWithin(0, 2));
const nested = { list: [{ a: 1 }, { b: [1, 2, { c: 3 }] }] };
console.log(nested, [nested]);
