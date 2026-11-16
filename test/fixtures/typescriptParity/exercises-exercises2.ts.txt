class BankAccount {
  private balance: number;
  private history: string[] = [];
  constructor(public readonly owner: string, initial: number = 0) {
    this.balance = initial;
  }
  deposit(amount: number): void {
    if (amount <= 0) throw new Error("Invalid amount");
    this.balance += amount;
    this.history.push(`+${amount}`);
  }
  withdraw(amount: number): boolean {
    if (amount > this.balance) return false;
    this.balance -= amount;
    this.history.push(`-${amount}`);
    return true;
  }
  getBalance(): number {
    return this.balance;
  }
  get log(): readonly string[] {
    return this.history;
  }
}
const acct = new BankAccount("Taro", 100);
acct.deposit(50);
console.log(acct.withdraw(500), acct.withdraw(30), acct.getBalance(), acct.log, acct.owner);
try {
  acct.deposit(-1);
} catch (e) {
  console.log(e instanceof Error ? e.message : e);
}
class Stack<T> {
  private items: T[] = [];
  push(item: T): void {
    this.items.push(item);
  }
  pop(): T | undefined {
    return this.items.pop();
  }
  peek(): T | undefined {
    return this.items[this.items.length - 1];
  }
  isEmpty(): boolean {
    return this.items.length === 0;
  }
  size(): number {
    return this.items.length;
  }
}
function isBalanced(s: string): boolean {
  const st = new Stack<string>();
  const pairs: { [key: string]: string } = { ")": "(", "]": "[", "}": "{" };
  for (const c of s) {
    if (c === "(" || c === "[" || c === "{") st.push(c);
    else if (c in pairs) {
      if (st.pop() !== pairs[c]) return false;
    }
  }
  return st.isEmpty();
}
console.log(isBalanced("([]{})"), isBalanced("(]"));
interface Shape {
  area(): number;
  name: string;
}
class Rect implements Shape {
  name = "rect";
  constructor(private w: number, private h: number) {}
  area() {
    return this.w * this.h;
  }
}
class Circle implements Shape {
  readonly name = "circle";
  constructor(private r: number) {}
  area(): number {
    return Math.PI * this.r ** 2;
  }
}
const shapes: Shape[] = [new Rect(2, 3), new Circle(1)];
for (const s of shapes) console.log(s.name, s.area().toFixed(3));
const totalArea = shapes.reduce((sum, s) => sum + s.area(), 0);
console.log(totalArea.toFixed(1));
type Item = { name: string; price: number; qty?: number };
const cart: Item[] = [{ name: "pen", price: 100, qty: 3 }, { name: "book", price: 1500 }];
const sum = cart.reduce((t, item) => t + item.price * (item.qty ?? 1), 0);
console.log(`合計: ${sum}円`);
class Queue<T> {
  private data: T[] = [];
  enqueue(x: T) {
    this.data.push(x);
  }
  dequeue(): T | undefined {
    return this.data.shift();
  }
  get length() {
    return this.data.length;
  }
}
const q = new Queue<number>();
q.enqueue(1);
q.enqueue(2);
console.log(q.dequeue(), q.length);
class Node2<T> {
  next: Node2<T> | null = null;
  constructor(public value: T) {}
}
class LinkedList<T> {
  head: Node2<T> | null = null;
  add(value: T) {
    const node = new Node2(value);
    if (!this.head) {
      this.head = node;
      return;
    }
    let cur = this.head;
    while (cur.next) cur = cur.next;
    cur.next = node;
  }
  toArray(): T[] {
    const out: T[] = [];
    let cur = this.head;
    while (cur) {
      out.push(cur.value);
      cur = cur.next;
    }
    return out;
  }
}
const list = new LinkedList<string>();
list.add("a");
list.add("b");
console.log(list.toArray());
const inventory = new Map<string, number>();
inventory.set("apple", 3);
inventory.set("pear", inventory.get("pear") ?? 0);
for (const [k, v] of inventory) console.log(`${k}=${v}`);
const unique = [...new Set([1, 2, 2, 3])];
console.log(unique);
enumLike();
function enumLike() {
  const Colors = { Red: "RED", Green: "GREEN" } as const;
  type Color = (typeof Colors)[keyof typeof Colors];
  const c: Color = Colors.Red;
  console.log(c);
}
