class A {
  private secret = 1;
  protected prot = 2;
  readonly ro = 3;
  x: number;
}
const a = new A();
console.log(a.secret, a.prot);
a.ro = 4;
abstract class B {
  abstract f(): void;
}
new B();
class C extends B {}
interface I {
  m(): number;
}
class D implements I {}
class E extends A {
  constructor() {
    this.x = 1;
    super();
  }
}
class F extends A {
  constructor() {}
}
