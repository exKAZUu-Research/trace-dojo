const re = /(\d+)-(\d+)/;
const m = "tel 12-345".match(re);
console.log(m?.[0], m?.[1], m?.index, re.test("a-b"), re.source, re.flags);
console.log("a1b22c333".replace(/\d+/g, (x) => `<${x.length}>`), "aaa".replace(/a/g, "b"), "x-y_z".split(/[-_]/));
const g = /o/g;
console.log(g.exec("foo")?.index, g.lastIndex, g.exec("foo")?.index, g.lastIndex);
console.log([..."a1b2".matchAll(/\d/g)].map((x) => x[0]), /^[A-Z]/i.test("abc"), new RegExp("b+", "g").exec("abbb"));
console.log("2024-01-05".replace(/(\d+)-(\d+)-(\d+)/, "$3/$2/$1"), /(?<y>\d{4})/.exec("in 2024")?.groups?.y);
console.log(/a/, /\//g, String(/x/m));
