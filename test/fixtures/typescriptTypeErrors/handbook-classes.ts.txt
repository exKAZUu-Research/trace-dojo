class Point {
  x: number;
  y: number;
}
class BadGreeter {
  name: string;
}
class Greeter {
  readonly name: string = "world";
  err() {
    this.name = "not ok";
  }
}
class Base {
  greet() {}
}
class Derived extends Base {
  greet(name: string) {}
}
class Base2 {
  x: number = 0;
}
class Derived2 extends Base2 {
  x: string = "";
}
interface Checkable {
  check(name: string): boolean;
}
class NameChecker implements Checkable {
  check(s) {
    return true;
  }
}
class Greeter2 {
  protected getName() {
    return "hi";
  }
}
const g = new Greeter2();
g.getName();
class MyClass {
  private static x = 0;
}
console.log(MyClass.x);
abstract class Base3 {
  abstract getName(): string;
}
const b = new Base3();
class Derived3 extends Base3 {
  getName() {
    return 1;
  }
}
function greet(ctor: typeof Base3) {
  const instance = new ctor();
}
class Box {
  contents = "";
  sameAs(other: this) {
    return other.contents === this.contents;
  }
}
class DerivedBox extends Box {
  otherContent = "?";
}
const base = new Box();
const derived = new DerivedBox();
derived.sameAs(base);
