const a: number = 1;
const b = a.toFixed(2).length;
const c = (a as any).foo.bar;
console.log(b, typeof c);
