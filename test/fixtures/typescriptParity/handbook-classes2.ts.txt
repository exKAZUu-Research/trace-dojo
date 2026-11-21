class Point {
  x: number;
  y: number;
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }
  scale(n: number): void {
    this.x *= n;
    this.y *= n;
  }
}
const pt = new Point();
pt.x = 0;
class GoodGreeter {
  name: string;
  constructor() {
    this.name = "hello";
  }
}
class OKGreeter {
  name!: string;
}
class Greeter {
  readonly name: string = "world";
  constructor(otherName?: string) {
    if (otherName !== undefined) {
      this.name = otherName;
    }
  }
}
console.log(new Greeter("x").name, new GoodGreeter().name);
class C {
  _length = 0;
  get length() {
    return this._length;
  }
  set length(value) {
    this._length = value;
  }
}
const c = new C();
c.length = 3;
console.log(c.length);
class MyClass {
  [s: string]: boolean | ((s: string) => boolean);
  check(s: string) {
    return this[s] as boolean;
  }
}
interface Pingable {
  ping(): void;
}
class Sonar implements Pingable {
  ping() {
    console.log("ping!");
  }
}
new Sonar().ping();
class Animal {
  move() {
    console.log("Moving along!");
  }
}
class Dog extends Animal {
  woof(times: number) {
    for (let i = 0; i < times; i++) console.log("woof!");
  }
}
const d = new Dog();
d.move();
d.woof(2);
class Base {
  greet() {
    console.log("Hello, world!");
  }
}
class Derived extends Base {
  greet(name?: string) {
    if (name === undefined) super.greet();
    else console.log(`Hello, ${name.toUpperCase()}`);
  }
}
const dd = new Derived();
dd.greet();
dd.greet("reader");
const b: Base = dd;
b.greet();
class Base2 {
  name = "base";
  constructor() {
    console.log("My name is " + this.name);
  }
}
class Derived2 extends Base2 {
  name = "derived";
}
const d2 = new Derived2();
class Greeter2 {
  public greet() {
    console.log("Hello, " + this.getName());
  }
  protected getName() {
    return "hi";
  }
}
class SpecialGreeter extends Greeter2 {
  public howdy() {
    console.log("Howdy, " + this.getName());
  }
}
new SpecialGreeter().howdy();
class A {
  private x = 10;
  public sameAs(other: A) {
    return other.x === this.x;
  }
}
console.log(new A().sameAs(new A()));
class MyClass2 {
  static x = 0;
  static printX() {
    console.log(MyClass2.x);
  }
}
MyClass2.printX();
class Foo {
  static #count = 0;
  get count() {
    return Foo.#count;
  }
  static {
    Foo.#count += 1;
  }
}
console.log(new Foo().count);
class Box<Type> {
  contents: Type;
  constructor(value: Type) {
    this.contents = value;
  }
}
const bb = new Box("hello!");
console.log(bb.contents.length);
class MyClass3 {
  name = "MyClass";
  getName = () => {
    return this.name;
  };
}
const cc3 = new MyClass3();
const g = cc3.getName;
console.log(g());
class Box2 {
  contents: string = "";
  set(value: string) {
    this.contents = value;
    return this;
  }
}
class ClearableBox extends Box2 {
  clear() {
    this.contents = "";
  }
}
const ab = new ClearableBox();
const chained = ab.set("hello");
chained.clear();
class Params {
  constructor(public readonly x: number, protected y: number, private z: number) {}
  sum() {
    return this.x + this.y + this.z;
  }
}
const pa = new Params(1, 2, 3);
console.log(pa.x, pa.sum());
const someClass = class<Type> {
  content: Type;
  constructor(value: Type) {
    this.content = value;
  }
};
const m = new someClass("Hello, world");
console.log(m.content);
abstract class Base3 {
  abstract getName(): string;
  printName() {
    console.log("Hello, " + this.getName());
  }
}
class Derived3 extends Base3 {
  getName() {
    return "world";
  }
}
new Derived3().printName();
function greet(ctor: new () => Base3) {
  const instance = new ctor();
  instance.printName();
}
greet(Derived3);
class Empty {}
function fn(x: Empty) {}
fn(window_like());
function window_like() {
  return {};
}
class Person {
  name: string;
  age: number;
  constructor(name: string, age: number) {
    this.name = name;
    this.age = age;
  }
}
class Employee {
  name: string;
  age: number;
  salary: number;
  constructor(name: string, age: number, salary: number) {
    this.name = name;
    this.age = age;
    this.salary = salary;
  }
}
const p: Person = new Employee("e", 1, 2);
console.log(p, d2.name, pt);
