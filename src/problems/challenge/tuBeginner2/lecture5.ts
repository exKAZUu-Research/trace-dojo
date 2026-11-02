import type { ChallengeBase } from '../types';

export const lecture5: ChallengeBase[] = [
  {
    id: 'challengeII5ProtectedCounter',
    title: '継承した状態を子クラスから変える',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Boost b = new Boost(); // caller\n    b.act(); // caller\n    b.boost(); // caller\n    b.act(); // caller\n    b.act(); // caller\n  }\n}\nclass Base {\n  protected Turtle t;\n  protected int count;\n  Base() {\n    this.t = new Turtle(2, 2); // step\n    this.count = 0; // step\n  }\n  void act() {\n    this.count++; // step\n    if (this.count > 2) {\n      this.t.右を向く(); // step\n    }\n    this.t.前に進む(); // step\n  }\n}\nclass Boost extends Base {\n  void boost() {\n    this.count += 2; // step\n  }\n}',
    instrumented:
      "function main() {\nlet b = call(Boost)(); registerDisplayRef('b', () => b); \ncall(b.act.bind(b))(); \ncall(b.boost.bind(b))(); \ncall(b.act.bind(b))(); \ncall(b.act.bind(b))(); \n}\nclass Base {\nt = undefined;\ncount = 0;\nconstructor() {\nthis.t = new Turtle(2, 2); // step\nthis.count = 0; // step\n}\nact() {\nthis.count++; // step\nif (this.count > 2) {\nthis.t.右を向く(); // step\n}\nthis.t.前に進む(); // step\n}\n}\nclass Boost extends Base {\nboost() {\nthis.count += 2; // step\n}\n}\nmain();",
    blanks: [
      {
        id: 'Boost',
        before: '    this.count += 2; // step',
        after: '    this.count += @[2]@; // step',
      },
      {
        id: 'Inherited',
        before: '    if (this.count > 2) {',
        after: '    if (this.count @[>]@ 2) {',
      },
      {
        id: 'Update',
        before: '    this.count++; // step',
        after: '    this.count@[++]@; // step',
      },
    ],
    bugs: [
      {
        id: 'Boost',
        before: '    this.count += 2; // step',
        after: '    this.count += 0; // step',
        kind: 'logical',
      },
      {
        id: 'Inherited',
        before: '    if (this.count > 2) {',
        after: '    if (this.count < 2) {',
        kind: 'logical',
      },
      {
        id: 'Update',
        before: '    this.count++; // step',
        after: '    this.count--; // step',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII5ReverseOrder',
    title: '移動と回転の順をオーバーライドする',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Base a = new Base(); // caller\n    Base b = new Reverse(); // caller\n    a.act(); // caller\n    b.act(); // caller\n    a.act(); // caller\n    b.act(); // caller\n  }\n}\nclass Base {\n  Turtle t;\n  Base() {\n    this.t = new Turtle(2, 2); // step\n  }\n  void act() {\n    this.t.右を向く(); // step\n    this.t.前に進む(); // step\n  }\n}\nclass Reverse extends Base {\n  void act() {\n    this.t.前に進む(); // step\n    this.t.右を向く(); // step\n  }\n}',
    instrumented:
      "function main() {\nlet a = call(Base)(); registerDisplayRef('a', () => a); \nlet b = call(Reverse)(); registerDisplayRef('b', () => b); \ncall(a.act.bind(a))(); \ncall(b.act.bind(b))(); \ncall(a.act.bind(a))(); \ncall(b.act.bind(b))(); \n}\nclass Base {\nt = undefined;\nconstructor() {\nthis.t = new Turtle(2, 2); // step\n}\nact() {\nthis.t.右を向く(); // step\nthis.t.前に進む(); // step\n}\n}\nclass Reverse extends Base {\nact() {\nthis.t.前に進む(); // step\nthis.t.右を向く(); // step\n}\n}\nmain();",
    blanks: [
      {
        id: 'Dynamic',
        before: '    Base b = new Reverse(); // caller',
        after: '    Base b = new @[Reverse]@(); // caller',
      },
      {
        id: 'Override',
        before: 'class Reverse extends Base {\n  void act() {\n    this.t.前に進む(); // step',
        after: 'class Reverse extends Base {\n  void act() {\n    this.t.@[前に進む]@(); // step',
      },
      {
        id: 'BaseTurn',
        before: '  void act() {\n    this.t.右を向く(); // step',
        after: '  void act() {\n    this.t.@[右を向く]@(); // step',
      },
    ],
    bugs: [
      {
        id: 'Dynamic',
        before: '    Base b = new Reverse(); // caller',
        after: '    Base b = new Base(); // caller',
        kind: 'logical',
      },
      {
        id: 'Override',
        before: 'class Reverse extends Base {\n  void act() {\n    this.t.前に進む(); // step',
        after: 'class Reverse extends Base {\n  void act() {\n    this.t.後に戻る(); // step',
        kind: 'logical',
      },
      {
        id: 'BaseTurn',
        before: '  void act() {\n    this.t.右を向く(); // step',
        after: '  void act() {\n    this.t.左を向く(); // step',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII5SuperSuffix',
    title: '親の動作の後で一歩戻る',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Base a = new Returner(); // caller\n    a.act(); // caller\n    a.t.左を向く(); // step\n    a.act(); // caller\n    a.t.前に進む(); // step\n  }\n}\nclass Base {\n  Turtle t;\n  Base() {\n    this.t = new Turtle(2, 2); // step\n  }\n  void act() {\n    this.t.前に進む(); // step\n    this.t.右を向く(); // step\n    this.t.前に進む(); // step\n  }\n}\nclass Returner extends Base {\n  void act() {\n    super.act(); // caller\n    this.t.後に戻る(); // step\n  }\n}',
    instrumented:
      "function main() {\nlet a = call(Returner)(); registerDisplayRef('a', () => a); \ncall(a.act.bind(a))(); \na.t.左を向く(); // step\ncall(a.act.bind(a))(); \na.t.前に進む(); // step\n}\nclass Base {\nt = undefined;\nconstructor() {\nthis.t = new Turtle(2, 2); // step\n}\nact() {\nthis.t.前に進む(); // step\nthis.t.右を向く(); // step\nthis.t.前に進む(); // step\n}\n}\nclass Returner extends Base {\nact() {\ncall(super.act.bind(this))(); \nthis.t.後に戻る(); // step\n}\n}\nmain();",
    blanks: [
      {
        id: 'Dispatch',
        before: '    Base a = new Returner(); // caller',
        after: '    Base a = new @[Returner]@(); // caller',
      },
      {
        id: 'Suffix',
        before: '    this.t.後に戻る(); // step',
        after: '    this.t.@[後に戻る]@(); // step',
      },
      {
        id: 'ParentTurn',
        before: '    this.t.右を向く(); // step',
        after: '    this.t.@[右を向く]@(); // step',
      },
    ],
    bugs: [
      {
        id: 'Dispatch',
        before: '    Base a = new Returner(); // caller',
        after: '    Base a = new Base(); // caller',
        kind: 'logical',
      },
      {
        id: 'Suffix',
        before: '    this.t.後に戻る(); // step',
        after: '    this.t.左を向く(); // step',
        kind: 'logical',
      },
      {
        id: 'ParentTurn',
        before: '    this.t.右を向く(); // step',
        after: '    this.t.左を向く(); // step',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII5ConstructorTransform',
    title: '親へ渡す値を子で変える',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Shifted a = new Shifted(1); // caller\n    a.act(); // caller\n    a.act(); // caller\n    a.t.左を向く(); // step\n    a.act(); // caller\n  }\n}\nclass Base {\n  Turtle t;\n  int mode;\n  Base(int value) {\n    this.t = new Turtle(2, 2); // step\n    this.mode = value; // step\n  }\n  void act() {\n    if (this.mode == 2) {\n      this.t.右を向く(); // step\n    }\n    this.t.前に進む(); // step\n    this.mode--; // step\n  }\n}\nclass Shifted extends Base {\n  Shifted(int value) {\n    super(value + 1); // caller\n    this.mode++; // step\n  }\n}',
    instrumented:
      "function main() {\nlet a = call(Shifted, 'value')(1); registerDisplayRef('a', () => a); \ncall(a.act.bind(a))(); \ncall(a.act.bind(a))(); \na.t.左を向く(); // step\ncall(a.act.bind(a))(); \n}\nclass Base {\nt = undefined;\nmode = 0;\nconstructor(value) {\nthis.t = new Turtle(2, 2); // step\nthis.mode = value; // step\n}\nact() {\nif (this.mode == 2) {\nthis.t.右を向く(); // step\n}\nthis.t.前に進む(); // step\nthis.mode--; // step\n}\n}\nclass Shifted extends Base {\nconstructor(value) {\ncall((value) => super(value), 'value')(value + 1);\nthis.mode++; // step\n}\n}\nmain();",
    blanks: [
      {
        id: 'SuperArgument',
        before: '    super(value + 1); // caller',
        after: '    super(value @[+ 1]@); // caller',
      },
      {
        id: 'ChildUpdate',
        before: '    this.mode++; // step',
        after: '    this.mode@[++]@; // step',
      },
      {
        id: 'InheritedGuard',
        before: '    if (this.mode == 2) {',
        after: '    if (this.mode == @[2]@) {',
      },
    ],
    bugs: [
      {
        id: 'SuperArgument',
        before: '    super(value + 1); // caller',
        after: '    super(value + 0); // caller',
        kind: 'logical',
      },
      {
        id: 'ChildUpdate',
        before: '    this.mode++; // step',
        after: '    this.mode--; // step',
        kind: 'logical',
      },
      {
        id: 'InheritedGuard',
        before: '    if (this.mode == 2) {',
        after: '    if (this.mode == 1) {',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII5TemplateDispatch',
    title: '親の組み合わせ動作から子を呼ぶ',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Base a = new Alternating(); // caller\n    a.pair(); // caller\n    a.pair(); // caller\n  }\n}\nclass Base {\n  Turtle t;\n  int count;\n  Base() {\n    this.t = new Turtle(2, 2); // step\n    this.count = 0; // step\n  }\n  void unit() {\n    this.t.前に進む(); // step\n  }\n  void pair() {\n    this.unit(); // caller\n    this.unit(); // caller\n  }\n}\nclass Alternating extends Base {\n  void unit() {\n    this.count++; // step\n    if (this.count % 2 == 0) {\n      this.t.右を向く(); // step\n    }\n    this.t.前に進む(); // step\n  }\n}',
    instrumented:
      "function main() {\nlet a = call(Alternating)(); registerDisplayRef('a', () => a); \ncall(a.pair.bind(a))(); \ncall(a.pair.bind(a))(); \n}\nclass Base {\nt = undefined;\ncount = 0;\nconstructor() {\nthis.t = new Turtle(2, 2); // step\nthis.count = 0; // step\n}\nunit() {\nthis.t.前に進む(); // step\n}\npair() {\ncall(this.unit.bind(this))(); \ncall(this.unit.bind(this))(); \n}\n}\nclass Alternating extends Base {\nunit() {\nthis.count++; // step\nif (this.count % 2 == 0) {\nthis.t.右を向く(); // step\n}\nthis.t.前に進む(); // step\n}\n}\nmain();",
    blanks: [
      {
        id: 'Dispatch',
        before: '    Base a = new Alternating(); // caller',
        after: '    Base a = new @[Alternating]@(); // caller',
      },
      {
        id: 'Parity',
        before: '    if (this.count % 2 == 0) {',
        after: '    if (this.count % 2 == @[0]@) {',
      },
      {
        id: 'Update',
        before: '    this.count++; // step',
        after: '    this.count@[++]@; // step',
      },
    ],
    bugs: [
      {
        id: 'Dispatch',
        before: '    Base a = new Alternating(); // caller',
        after: '    Base a = new Base(); // caller',
        kind: 'logical',
      },
      {
        id: 'Parity',
        before: '    if (this.count % 2 == 0) {',
        after: '    if (this.count % 2 == 1) {',
        kind: 'logical',
      },
      {
        id: 'Update',
        before: '    this.count++; // step',
        after: '    this.count += 0; // step',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII5ReboundBase',
    title: '同じ親型の名前で異なる子を呼ぶ',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Left a = new Left(); // caller\n    Right b = new Right(); // caller\n    Base selected = a; // step\n    selected.act(); // caller\n    selected = b; // step\n    selected.act(); // caller\n    selected = a; // step\n    selected.act(); // caller\n    b.act(); // caller\n  }\n}\nclass Base {\n  Turtle t;\n  Base() {\n    this.t = new Turtle(2, 2); // step\n  }\n  void act() {\n    this.t.前に進む(); // step\n  }\n}\nclass Left extends Base {\n  void act() {\n    this.t.左を向く(); // step\n    this.t.前に進む(); // step\n  }\n}\nclass Right extends Base {\n  void act() {\n    this.t.前に進む(); // step\n    this.t.右を向く(); // step\n  }\n}',
    instrumented:
      "function main() {\nlet a = call(Left)(); registerDisplayRef('a', () => a); \nlet b = call(Right)(); registerDisplayRef('b', () => b); \nlet selected = a; registerDisplayRef('selected', () => selected); // step\ncall(selected.act.bind(selected))(); \nselected = b; // step\ncall(selected.act.bind(selected))(); \nselected = a; // step\ncall(selected.act.bind(selected))(); \ncall(b.act.bind(b))(); \n}\nclass Base {\nt = undefined;\nconstructor() {\nthis.t = new Turtle(2, 2); // step\n}\nact() {\nthis.t.前に進む(); // step\n}\n}\nclass Left extends Base {\nact() {\nthis.t.左を向く(); // step\nthis.t.前に進む(); // step\n}\n}\nclass Right extends Base {\nact() {\nthis.t.前に進む(); // step\nthis.t.右を向く(); // step\n}\n}\nmain();",
    blanks: [
      {
        id: 'Rebind',
        before: '    selected = b; // step',
        after: '    selected = @[b]@; // step',
      },
      {
        id: 'Left',
        before: '    this.t.左を向く(); // step',
        after: '    this.t.@[左を向く]@(); // step',
      },
      {
        id: 'Right',
        before: 'class Right extends Base {\n  void act() {\n    this.t.前に進む(); // step',
        after: 'class Right extends Base {\n  void act() {\n    this.t.@[前に進む]@(); // step',
      },
    ],
    bugs: [
      {
        id: 'Rebind',
        before: '    selected = b; // step',
        after: '    selected = a; // step',
        kind: 'logical',
      },
      {
        id: 'Left',
        before: '    this.t.左を向く(); // step',
        after: '    this.t.右を向く(); // step',
        kind: 'logical',
      },
      {
        id: 'Right',
        before: 'class Right extends Base {\n  void act() {\n    this.t.前に進む(); // step',
        after: 'class Right extends Base {\n  void act() {\n    this.t.後に戻る(); // step',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII5ArrayDispatch',
    title: '配列から選んだ子の動作',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Base a = new Corner(); // caller\n    Base b = new Retreat(); // caller\n    Base[] choices = {b, a}; // step\n    Base first = choices[0]; // step\n    Base second = choices[1]; // step\n    first.act(); // caller\n    second.act(); // caller\n    first.act(); // caller\n  }\n}\nclass Base {\n  Turtle t;\n  Base() {\n    this.t = new Turtle(3, 3); // step\n  }\n  void act() {\n    this.t.前に進む(); // step\n  }\n}\nclass Corner extends Base {\n  void act() {\n    this.t.右を向く(); // step\n    this.t.前に進む(); // step\n    this.t.左を向く(); // step\n  }\n}\nclass Retreat extends Base {\n  void act() {\n    this.t.後に戻る(); // step\n    this.t.左を向く(); // step\n  }\n}',
    instrumented:
      "function main() {\nlet a = call(Corner)(); registerDisplayRef('a', () => a); \nlet b = call(Retreat)(); registerDisplayRef('b', () => b); \nlet choices = [b, a]; registerDisplayRef('choices', () => choices); // step\nlet first = choices[0]; registerDisplayRef('first', () => first); // step\nlet second = choices[1]; registerDisplayRef('second', () => second); // step\ncall(first.act.bind(first))(); \ncall(second.act.bind(second))(); \ncall(first.act.bind(first))(); \n}\nclass Base {\nt = undefined;\nconstructor() {\nthis.t = new Turtle(3, 3); // step\n}\nact() {\nthis.t.前に進む(); // step\n}\n}\nclass Corner extends Base {\nact() {\nthis.t.右を向く(); // step\nthis.t.前に進む(); // step\nthis.t.左を向く(); // step\n}\n}\nclass Retreat extends Base {\nact() {\nthis.t.後に戻る(); // step\nthis.t.左を向く(); // step\n}\n}\nmain();",
    blanks: [
      {
        id: 'Array',
        before: '    Base[] choices = {b, a}; // step',
        after: '    Base[] choices = {@[b, a]@}; // step',
      },
      {
        id: 'Selected',
        before: '    Base second = choices[1]; // step',
        after: '    Base second = choices[@[1]@]; // step',
      },
      {
        id: 'Retreat',
        before: '    this.t.後に戻る(); // step',
        after: '    this.t.@[後に戻る]@(); // step',
      },
    ],
    bugs: [
      {
        id: 'Array',
        before: '    Base[] choices = {b, a}; // step',
        after: '    Base[] choices = {a, b}; // step',
        kind: 'logical',
      },
      {
        id: 'Selected',
        before: '    Base second = choices[1]; // step',
        after: '    Base second = choices[0]; // step',
        kind: 'logical',
      },
      {
        id: 'Retreat',
        before: '    this.t.後に戻る(); // step',
        after: '    this.t.前に進む(); // step',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII5MixedHelpers',
    title: '継承する補助動作と上書きする補助動作',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Base a = new Changed(); // caller\n    a.draw(); // caller\n    a.draw(); // caller\n    a.t.右を向く(); // step\n  }\n}\nclass Base {\n  Turtle t;\n  Base() {\n    this.t = new Turtle(2, 2); // step\n  }\n  void first() {\n    this.t.前に進む(); // step\n    this.t.右を向く(); // step\n  }\n  void second() {\n    this.t.前に進む(); // step\n  }\n  void draw() {\n    this.first(); // caller\n    this.second(); // caller\n  }\n}\nclass Changed extends Base {\n  void second() {\n    this.t.左を向く(); // step\n    this.t.前に進む(); // step\n  }\n}',
    instrumented:
      "function main() {\nlet a = call(Changed)(); registerDisplayRef('a', () => a); \ncall(a.draw.bind(a))(); \ncall(a.draw.bind(a))(); \na.t.右を向く(); // step\n}\nclass Base {\nt = undefined;\nconstructor() {\nthis.t = new Turtle(2, 2); // step\n}\nfirst() {\nthis.t.前に進む(); // step\nthis.t.右を向く(); // step\n}\nsecond() {\nthis.t.前に進む(); // step\n}\ndraw() {\ncall(this.first.bind(this))(); \ncall(this.second.bind(this))(); \n}\n}\nclass Changed extends Base {\nsecond() {\nthis.t.左を向く(); // step\nthis.t.前に進む(); // step\n}\n}\nmain();",
    blanks: [
      {
        id: 'Inherited',
        before: '    this.t.右を向く(); // step\n  }\n  void second() {',
        after: '    this.t.@[右を向く]@(); // step\n  }\n  void second() {',
      },
      {
        id: 'Override',
        before: '    Base a = new Changed(); // caller',
        after: '    Base a = new @[Changed]@(); // caller',
      },
      {
        id: 'Child',
        before: '    this.t.左を向く(); // step',
        after: '    this.t.@[左を向く]@(); // step',
      },
    ],
    bugs: [
      {
        id: 'Inherited',
        before: '    this.t.右を向く(); // step\n  }\n  void second() {',
        after: '    this.t.左を向く(); // step\n  }\n  void second() {',
        kind: 'logical',
      },
      {
        id: 'Override',
        before: '    Base a = new Changed(); // caller',
        after: '    Base a = new Base(); // caller',
        kind: 'logical',
      },
      {
        id: 'Child',
        before: '    this.t.左を向く(); // step',
        after: '    this.t.右を向く(); // step',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII5SuperChain',
    title: '三段階のsuper呼び出し',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Base a = new Last(); // caller\n    a.act(); // caller\n    a.t.右を向く(); // step\n    a.act(); // caller\n    a.t.後に戻る(); // step\n  }\n}\nclass Base {\n  Turtle t;\n  Base() {\n    this.t = new Turtle(2, 2); // step\n  }\n  void act() {\n    this.t.前に進む(); // step\n    this.t.右を向く(); // step\n  }\n}\nclass Middle extends Base {\n  void act() {\n    super.act(); // caller\n    this.t.前に進む(); // step\n  }\n}\nclass Last extends Middle {\n  void act() {\n    super.act(); // caller\n    this.t.左を向く(); // step\n  }\n}',
    instrumented:
      "function main() {\nlet a = call(Last)(); registerDisplayRef('a', () => a); \ncall(a.act.bind(a))(); \na.t.右を向く(); // step\ncall(a.act.bind(a))(); \na.t.後に戻る(); // step\n}\nclass Base {\nt = undefined;\nconstructor() {\nthis.t = new Turtle(2, 2); // step\n}\nact() {\nthis.t.前に進む(); // step\nthis.t.右を向く(); // step\n}\n}\nclass Middle extends Base {\nact() {\ncall(super.act.bind(this))(); \nthis.t.前に進む(); // step\n}\n}\nclass Last extends Middle {\nact() {\ncall(super.act.bind(this))(); \nthis.t.左を向く(); // step\n}\n}\nmain();",
    blanks: [
      {
        id: 'Chain',
        before: '    Base a = new Last(); // caller',
        after: '    Base a = new @[Last]@(); // caller',
      },
      {
        id: 'Last',
        before: '    this.t.左を向く(); // step',
        after: '    this.t.@[左を向く]@(); // step',
      },
      {
        id: 'Middle',
        before:
          'class Middle extends Base {\n  void act() {\n    super.act(); // caller\n    this.t.前に進む(); // step',
        after:
          'class Middle extends Base {\n  void act() {\n    super.act(); // caller\n    this.t.@[前に進む]@(); // step',
      },
    ],
    bugs: [
      {
        id: 'Chain',
        before: '    Base a = new Last(); // caller',
        after: '    Base a = new Middle(); // caller',
        kind: 'logical',
      },
      {
        id: 'Last',
        before: '    this.t.左を向く(); // step',
        after: '    this.t.右を向く(); // step',
        kind: 'logical',
      },
      {
        id: 'Middle',
        before:
          'class Middle extends Base {\n  void act() {\n    super.act(); // caller\n    this.t.前に進む(); // step',
        after:
          'class Middle extends Base {\n  void act() {\n    super.act(); // caller\n    this.t.後に戻る(); // step',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII5StateOverride',
    title: '状態によって親の動作を選ぶ',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Base a = new Alternating(); // caller\n    a.act(); // caller\n    a.act(); // caller\n    a.act(); // caller\n    a.act(); // caller\n  }\n}\nclass Base {\n  Turtle t;\n  int count;\n  Base() {\n    this.t = new Turtle(2, 2); // step\n    this.count = 0; // step\n  }\n  void act() {\n    this.t.前に進む(); // step\n  }\n}\nclass Alternating extends Base {\n  void act() {\n    this.count++; // step\n    if (this.count % 2 == 1) {\n      super.act(); // caller\n    } else {\n      this.t.右を向く(); // step\n      this.t.前に進む(); // step\n    }\n  }\n}',
    instrumented:
      "function main() {\nlet a = call(Alternating)(); registerDisplayRef('a', () => a); \ncall(a.act.bind(a))(); \ncall(a.act.bind(a))(); \ncall(a.act.bind(a))(); \ncall(a.act.bind(a))(); \n}\nclass Base {\nt = undefined;\ncount = 0;\nconstructor() {\nthis.t = new Turtle(2, 2); // step\nthis.count = 0; // step\n}\nact() {\nthis.t.前に進む(); // step\n}\n}\nclass Alternating extends Base {\nact() {\nthis.count++; // step\nif (this.count % 2 == 1) {\ncall(super.act.bind(this))(); \n} else {\nthis.t.右を向く(); // step\nthis.t.前に進む(); // step\n}\n}\n}\nmain();",
    blanks: [
      {
        id: 'Parity',
        before: '    if (this.count % 2 == 1) {',
        after: '    if (this.count % 2 == @[1]@) {',
      },
      {
        id: 'Override',
        before: '    Base a = new Alternating(); // caller',
        after: '    Base a = new @[Alternating]@(); // caller',
      },
      {
        id: 'ChildTurn',
        before: '      this.t.右を向く(); // step',
        after: '      this.t.@[右を向く]@(); // step',
      },
    ],
    bugs: [
      {
        id: 'Parity',
        before: '    if (this.count % 2 == 1) {',
        after: '    if (this.count % 2 == 0) {',
        kind: 'logical',
      },
      {
        id: 'Override',
        before: '    Base a = new Alternating(); // caller',
        after: '    Base a = new Base(); // caller',
        kind: 'logical',
      },
      {
        id: 'ChildTurn',
        before: '      this.t.右を向く(); // step',
        after: '      this.t.左を向く(); // step',
        kind: 'logical',
      },
    ],
  },
];
