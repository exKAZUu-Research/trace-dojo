class Animal {
  protected sound = "...";
  static count = 0;
  #secret = 42;
  constructor(public name: string, private readonly age: number) {
    Animal.count++;
  }
  speak(): string {
    return `${this.name} says ${this.sound}`;
  }
  get info(): string {
    return `${this.name} (${this.age})`;
  }
  set nickname(value: string) {
    this.name = value;
  }
  reveal(): number {
    return this.#secret;
  }
  static create(name: string): Animal {
    return new Animal(name, 1);
  }
}
class Dog extends Animal {
  constructor(name: string) {
    super(name, 3);
    this.sound = "woof";
  }
  speak(): string {
    return super.speak() + "!";
  }
}
const d = new Dog("Rex");
console.log(d.speak(), d.info, d.reveal(), Animal.count, d instanceof Animal, d);
d.nickname = "R";
console.log(d.name, Animal.create("Cat"), Animal.count);
abstract class Shape {
  abstract area(): number;
  describe(): string {
    return `area=${this.area().toFixed(2)}`;
  }
}
class Circle extends Shape {
  constructor(private r: number) {
    super();
  }
  area(): number {
    return Math.PI * this.r * this.r;
  }
}
console.log(new Circle(2).describe());
interface Greeter {
  greet(): string;
}
class English implements Greeter {
  greet() {
    return "hello";
  }
}
const g: Greeter = new English();
console.log(g.greet());
class Box<T> {
  private items: T[] = [];
  add(item: T): this {
    this.items.push(item);
    return this;
  }
  get size(): number {
    return this.items.length;
  }
  first(): T | undefined {
    return this.items[0];
  }
}
const b = new Box<string>().add("a").add("b");
console.log(b.size, b.first(), b);
class Counter {
  static {
    console.log("static block");
  }
  value!: number;
  declare note: string;
  init() {
    this.value = 1;
  }
}
const c = new Counter();
c.init();
console.log(c);
const Named = class {
  hello() {
    return "named class";
  }
};
console.log(new Named().hello());
class Err extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Err";
  }
}
try {
  throw new Err("custom");
} catch (e) {
  if (e instanceof Err) console.log(e.name, e.message, e instanceof Error);
}
