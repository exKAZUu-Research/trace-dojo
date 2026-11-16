class OutOfStockError extends Error {
  constructor(public item: string) {
    super(`${item} is out of stock`);
    this.name = "OutOfStockError";
  }
}
function deep(n: number): number {
  return n === 0 ? 0 : 1 + deep(n - 1);
}
console.log(deep(500));
const stock = new Map<string, number>([["pen", 0]]);
function buy(item: string): void {
  if ((stock.get(item) ?? 0) === 0) throw new OutOfStockError(item);
}
try {
  buy("pen");
} catch (e) {
  if (e instanceof OutOfStockError) console.log(e.name, e.item, e.message);
}
const data: any = JSON.parse('{"a": null}');
try {
  data.a.b;
} catch (e) {
  console.log(e instanceof TypeError, (e as Error).message);
}
buy("pen");
console.log("not reached");
