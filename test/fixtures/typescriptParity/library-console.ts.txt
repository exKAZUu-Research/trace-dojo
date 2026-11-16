console.log("%s is %d years", "Ann", 30.7, "extra");
console.log("%i %f %o %O %j %%", 4.9, "2.5", { a: [1] }, { b: 2 }, { c: 3 });
console.log("%c styled", "color: red");
console.log();
console.log("");
console.log(undefined, null, NaN, -0, 0, Infinity, -Infinity);
console.log([undefined, null, NaN, -0], { u: undefined, n: null });
console.log({ "key with space": 1, valid_id: 2, 3: "num", "日本": 4 });
console.log([function named() {}, () => 1, class K {}, Symbol("s"), 10n]);
console.log({ f() {}, g: () => 2, get x() { return 1; } });
console.log(new Error("boom").message, String(new RangeError("r")), [new TypeError("t")].length);
console.log("a".repeat(120));
console.log(Array.from({ length: 30 }, (_, i) => i * 1000));
console.log({ long: "x".repeat(60), more: "y".repeat(20), arr: [1, 2, 3] });
console.log([[1, 2, [3, 4, [5, 6, [7, 8]]]]], { a: { b: { c: { d: { e: 1 } } } } });
console.info("info");
console.debug("debug");
console.error("to stderr");
console.warn("warn");
const circ: { self?: unknown; v: number } = { v: 1 };
circ.self = circ;
console.log(circ);
console.log(new Map([["k", { deep: [1, { x: 2 }] }]]), new Set([[1, 2]]));
console.log([1.5, "s", true, null, undefined, [], {}]);
console.log(Object.create(null));
class P {
  constructor(public x: number, private y: string) {}
}
console.log(new P(1, "a"), [new P(2, "b")]);
console.table([{ a: 1, b: 2 }, { a: 3, b: 4 }]);
console.log("%s", { a: 1 }, "%s");
console.count();
console.count("x");
console.count();
