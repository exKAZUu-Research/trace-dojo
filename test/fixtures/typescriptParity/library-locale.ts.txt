console.log((1234567.891).toLocaleString(), (0.5).toLocaleString("ja-JP", { style: "percent" }), (1234.5).toLocaleString("en-US", { minimumFractionDigits: 2 }));
console.log([1000, 2000.5, null, "x"].toLocaleString(), ({}).toLocaleString(), "İstanbul".toLocaleLowerCase(), "i".toLocaleUpperCase("tr-TR"));
console.log("abcdef".substr(1, 3), "abcdef".substr(-2), "abcdef".substr(2), " a ".trimLeft() + "|", "x".bold(), "y".link('u"r'), "ab\uD800".isWellFormed(), "ab".toWellFormed());
console.log((12345.6789).toLocaleString(undefined, { maximumFractionDigits: 1 }), (5).toLocaleString("de-DE", { style: "currency", currency: "EUR" }));
