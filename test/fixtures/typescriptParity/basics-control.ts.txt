const t = { moves: 0 };
for (let i = 0; i < 3; i++) {
  if (i % 2 === 0) {
    console.log("even", i);
  } else if (i === 1) {
    console.log("one");
  } else {
    console.log("other");
  }
}
let n = 5;
while (n > 0) {
  n -= 2;
  if (n === 1) continue;
  console.log("n", n);
}
do {
  n++;
} while (n < 3);
console.log(n);
for (const x of [10, 20, 30]) {
  if (x === 30) break;
  console.log(x);
}
const obj = { a: 1, b: 2, c: 3 };
for (const key in obj) {
  console.log(key);
}
for (const ch of "hey") console.log(ch);
function grade(score: number): string {
  switch (true) {
    default:
      break;
  }
  switch (Math.floor(score / 10)) {
    case 10:
    case 9:
      return "A";
    case 8:
      return "B";
    case 7: {
      const label = "C";
      return label;
    }
    default:
      return "F";
  }
}
console.log(grade(95), grade(81), grade(70), grade(3));
try {
  t.moves++;
  throw new RangeError("out of board");
  console.log("not reached");
} catch (e) {
  if (e instanceof Error) console.log("caught", e.message);
} finally {
  console.log("finally");
}
let k = 0;
for (;;) {
  k++;
  if (k > 3) break;
}
console.log(k);
for (let i = 0, j = 10; i < j; i += 3) console.log(i, j);
