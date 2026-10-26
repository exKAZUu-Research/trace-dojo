import type { ChallengeBase } from '../types';

export const lecture6: ChallengeBase[] = [
  {
    id: 'challengeII6StoredDefault',
    title: '引数なしの呼び出しが保存値を使う',
    courseId: 'tuBeginner2',
    lectureIndex: 5,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Dial d = new Dial(); // caller\n    d.act(); // caller\n    d.amount = 0; // step\n    d.act(); // caller\n    d.act(1); // caller\n    d.amount = 2; // step\n    d.act(); // caller\n  }\n}\nclass Dial {\n  Turtle t;\n  int amount;\n  Dial() {\n    this.t = new Turtle(2, 2); // step\n    this.amount = 1; // step\n  }\n  void act() {\n    this.act(this.amount); // caller\n  }\n  void act(int value) {\n    if (value > 0) {\n      this.t.前に進む(); // step\n    }\n    this.t.右を向く(); // step\n  }\n}',
    instrumented:
      "function main() {\nlet d = call(Dial)(); registerDisplayRef('d', () => d); \ncall(d.actDefault.bind(d))(); \nd.amount = 0; // step\ncall(d.actDefault.bind(d))(); \ncall(d.actCount.bind(d), 'value')(1); \nd.amount = 2; // step\ncall(d.actDefault.bind(d))(); \n}\nclass Dial {\nt = undefined;\namount = 0;\nconstructor() {\nthis.t = new Turtle(2, 2); // step\nthis.amount = 1; // step\n}\nactDefault() {\ncall(this.actCount.bind(this), 'value')(this.amount); \n}\nactCount(value) {\nif (value > 0) {\nthis.t.前に進む(); // step\n}\nthis.t.右を向く(); // step\n}\n}\nmain();",
    blanks: [
      {
        id: 'Delegate',
        before: '    this.act(this.amount); // caller',
        after: '    this.act(@[this.amount]@); // caller',
      },
      {
        id: 'Argument',
        before: '    d.act(1); // caller',
        after: '    d.act(@[1]@); // caller',
      },
      {
        id: 'Guard',
        before: '    if (value > 0) {',
        after: '    if (value @[>]@ 0) {',
      },
    ],
    bugs: [
      {
        id: 'Delegate',
        before: '    this.act(this.amount); // caller',
        after: '    this.act(0); // caller',
        kind: 'logical',
      },
      {
        id: 'Argument',
        before: '    d.act(1); // caller',
        after: '    d.act(0); // caller',
        kind: 'logical',
      },
      {
        id: 'Guard',
        before: '    if (value > 0) {',
        after: '    if (value == 0) {',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII6BooleanAndNumber',
    title: '論理値と整数で異なる設定',
    courseId: 'tuBeginner2',
    lectureIndex: 5,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Dial d = new Dial(); // caller\n    d.set(1); // caller\n    d.set(true); // caller\n    d.move(); // caller\n    d.set(false); // caller\n    d.move(); // caller\n    d.set(0); // caller\n    d.move(); // caller\n  }\n}\nclass Dial {\n  Turtle t;\n  int count;\n  boolean right;\n  Dial() {\n    this.t = new Turtle(2, 2); // step\n    this.count = 0; // step\n    this.right = false; // step\n  }\n  void set(int value) {\n    this.count = value; // step\n  }\n  void set(boolean value) {\n    this.right = value; // step\n  }\n  void move() {\n    if (this.right) {\n      this.t.右を向く(); // step\n    }\n    if (this.count > 0) {\n      this.t.前に進む(); // step\n    }\n  }\n}',
    instrumented:
      "function main() {\nlet d = call(Dial)(); registerDisplayRef('d', () => d); \ncall(d.setCount.bind(d), 'value')(1); \ncall(d.setMode.bind(d), 'value')(true); \ncall(d.move.bind(d))(); \ncall(d.setMode.bind(d), 'value')(false); \ncall(d.move.bind(d))(); \ncall(d.setCount.bind(d), 'value')(0); \ncall(d.move.bind(d))(); \n}\nclass Dial {\nt = undefined;\ncount = 0;\nright = false;\nconstructor() {\nthis.t = new Turtle(2, 2); // step\nthis.count = 0; // step\nthis.right = false; // step\n}\nsetCount(value) {\nthis.count = value; // step\n}\nsetMode(value) {\nthis.right = value; // step\n}\nmove() {\nif (this.right) {\nthis.t.右を向く(); // step\n}\nif (this.count > 0) {\nthis.t.前に進む(); // step\n}\n}\n}\nmain();",
    blanks: [
      {
        id: 'Boolean',
        before: '    d.set(true); // caller',
        after: '    d.set(@[true]@); // caller',
      },
      {
        id: 'Numeric',
        before: '    this.count = value; // step',
        after: '    this.count = @[value]@; // step',
      },
      {
        id: 'Mode',
        before: '    this.right = value; // step',
        after: '    this.right = @[value]@; // step',
      },
    ],
    bugs: [
      {
        id: 'Boolean',
        before: '    d.set(true); // caller',
        after: '    d.set(false); // caller',
        kind: 'logical',
      },
      {
        id: 'Numeric',
        before: '    this.count = value; // step',
        after: '    this.count = 0; // step',
        kind: 'logical',
      },
      {
        id: 'Mode',
        before: '    this.right = value; // step',
        after: '    this.right = !value; // step',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII6OneAndTwoFields',
    title: '引数の数によって更新するフィールドが違う',
    courseId: 'tuBeginner2',
    lectureIndex: 5,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Dial d = new Dial(); // caller\n    d.change(2, 1); // caller\n    d.move(); // caller\n    d.change(0); // caller\n    d.move(); // caller\n    d.change(1, 2); // caller\n    d.move(); // caller\n  }\n}\nclass Dial {\n  Turtle t;\n  int left;\n  int right;\n  Dial() {\n    this.t = new Turtle(2, 2); // step\n    this.left = 0; // step\n    this.right = 0; // step\n  }\n  void change(int value) {\n    this.left = value; // step\n  }\n  void change(int first, int second) {\n    this.left = first; // step\n    this.right = second; // step\n  }\n  void move() {\n    if (this.left > this.right) {\n      this.t.右を向く(); // step\n    } else {\n      this.t.左を向く(); // step\n    }\n    this.t.前に進む(); // step\n  }\n}',
    instrumented:
      "function main() {\nlet d = call(Dial)(); registerDisplayRef('d', () => d); \ncall(d.changePair.bind(d), 'first', 'second')(2, 1); \ncall(d.move.bind(d))(); \ncall(d.changeOne.bind(d), 'value')(0); \ncall(d.move.bind(d))(); \ncall(d.changePair.bind(d), 'first', 'second')(1, 2); \ncall(d.move.bind(d))(); \n}\nclass Dial {\nt = undefined;\nleft = 0;\nright = 0;\nconstructor() {\nthis.t = new Turtle(2, 2); // step\nthis.left = 0; // step\nthis.right = 0; // step\n}\nchangeOne(value) {\nthis.left = value; // step\n}\nchangePair(first, second) {\nthis.left = first; // step\nthis.right = second; // step\n}\nmove() {\nif (this.left > this.right) {\nthis.t.右を向く(); // step\n} else {\nthis.t.左を向く(); // step\n}\nthis.t.前に進む(); // step\n}\n}\nmain();",
    blanks: [
      {
        id: 'Pair',
        before: '    this.right = second; // step',
        after: '    this.right = @[second]@; // step',
      },
      {
        id: 'One',
        before: '    this.left = value; // step',
        after: '    this.left = @[value]@; // step',
      },
      {
        id: 'Select',
        before: '    d.change(1, 2); // caller',
        after: '    d.change(@[1, 2]@); // caller',
      },
    ],
    bugs: [
      {
        id: 'Pair',
        before: '    this.right = second; // step',
        after: '    this.right = first; // step',
        kind: 'logical',
      },
      {
        id: 'One',
        before: '    this.left = value; // step',
        after: '    this.left = value + 2; // step',
        kind: 'logical',
      },
      {
        id: 'Select',
        before: '    d.change(1, 2); // caller',
        after: '    d.change(2, 1); // caller',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII6ObjectOrDefault',
    title: '引数の亀と保存された亀を使い分ける',
    courseId: 'tuBeginner2',
    lectureIndex: 5,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Turtle a = new Turtle(2, 2); // step\n    Turtle b = new Turtle(4, 2, "R"); // step\n    Dial d = new Dial(a); // caller\n    d.draw(); // caller\n    d.draw(b); // caller\n    a.後に戻る(); // step\n    d.draw(); // caller\n    b.左を向く(); // step\n  }\n}\nclass Dial {\n  Turtle saved;\n  Dial(Turtle initial) {\n    this.saved = initial; // step\n  }\n  void draw() {\n    this.draw(this.saved); // caller\n  }\n  void draw(Turtle target) {\n    target.右を向く(); // step\n    target.前に進む(); // step\n  }\n}',
    instrumented:
      "function main() {\nlet a = new Turtle(2, 2); registerDisplayRef('a', () => a); // step\nlet b = new Turtle(4, 2, \"R\"); registerDisplayRef('b', () => b); // step\nlet d = call(Dial, 'initial')(a); registerDisplayRef('d', () => d); \ncall(d.drawDefault.bind(d))(); \ncall(d.drawOther.bind(d), 'target')(b); \na.後に戻る(); // step\ncall(d.drawDefault.bind(d))(); \nb.左を向く(); // step\n}\nclass Dial {\nsaved = undefined;\nconstructor(initial) {\nthis.saved = initial; // step\n}\ndrawDefault() {\ncall(this.drawOther.bind(this), 'target')(this.saved); \n}\ndrawOther(target) {\ntarget.右を向く(); // step\ntarget.前に進む(); // step\n}\n}\nmain();",
    blanks: [
      {
        id: 'Target',
        before: '    d.draw(b); // caller',
        after: '    d.draw@[(b)]@; // caller',
      },
      {
        id: 'Saved',
        before: '    Dial d = new Dial(a); // caller',
        after: '    Dial d = new Dial@[(a)]@; // caller',
      },
      {
        id: 'Turn',
        before: '    target.右を向く(); // step',
        after: '    target.@[右を向く]@(); // step',
      },
    ],
    bugs: [
      {
        id: 'Target',
        before: '    d.draw(b); // caller',
        after: '    d.draw(a); // caller',
        kind: 'logical',
      },
      {
        id: 'Saved',
        before: '    Dial d = new Dial(a); // caller',
        after: '    Dial d = new Dial(b); // caller',
        kind: 'logical',
      },
      {
        id: 'Turn',
        before: '    target.右を向く(); // step',
        after: '    target.左を向く(); // step',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII6TextAndCount',
    title: '文字列と整数のオーバーロード',
    courseId: 'tuBeginner2',
    lectureIndex: 5,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Dial d = new Dial(); // caller\n    d.command(1); // caller\n    d.move(); // caller\n    d.command("turn"); // caller\n    d.move(); // caller\n    d.command(0); // caller\n    d.move(); // caller\n    d.command("turn"); // caller\n  }\n}\nclass Dial {\n  Turtle t;\n  int count;\n  Dial() {\n    this.t = new Turtle(2, 2); // step\n    this.count = 0; // step\n  }\n  void command(int value) {\n    this.count = value; // step\n  }\n  void command(String text) {\n    this.t.右を向く(); // step\n  }\n  void move() {\n    if (this.count == 1) {\n      this.t.前に進む(); // step\n    }\n    this.t.左を向く(); // step\n  }\n}',
    instrumented:
      "function main() {\nlet d = call(Dial)(); registerDisplayRef('d', () => d); \ncall(d.commandCount.bind(d), 'value')(1); \ncall(d.move.bind(d))(); \ncall(d.commandText.bind(d), 'text')(\"turn\"); \ncall(d.move.bind(d))(); \ncall(d.commandCount.bind(d), 'value')(0); \ncall(d.move.bind(d))(); \ncall(d.commandText.bind(d), 'text')(\"turn\"); \n}\nclass Dial {\nt = undefined;\ncount = 0;\nconstructor() {\nthis.t = new Turtle(2, 2); // step\nthis.count = 0; // step\n}\ncommandCount(value) {\nthis.count = value; // step\n}\ncommandText(text) {\nthis.t.右を向く(); // step\n}\nmove() {\nif (this.count == 1) {\nthis.t.前に進む(); // step\n}\nthis.t.左を向く(); // step\n}\n}\nmain();",
    blanks: [
      {
        id: 'Count',
        before: '    d.command(1); // caller',
        after: '    d.command(@[1]@); // caller',
      },
      {
        id: 'TextAction',
        before: '    this.t.右を向く(); // step',
        after: '    this.t.@[右を向く]@(); // step',
      },
      {
        id: 'Read',
        before: '    if (this.count == 1) {',
        after: '    if (this.count @[==]@ 1) {',
      },
    ],
    bugs: [
      {
        id: 'Count',
        before: '    d.command(1); // caller',
        after: '    d.command(0); // caller',
        kind: 'logical',
      },
      {
        id: 'TextAction',
        before: '    this.t.右を向く(); // step',
        after: '    this.t.左を向く(); // step',
        kind: 'logical',
      },
      {
        id: 'Read',
        before: '    if (this.count == 1) {',
        after: '    if (this.count != 1) {',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII6InheritedSignature',
    title: '親の引数ありと子の引数なし',
    courseId: 'tuBeginner2',
    lectureIndex: 5,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Child d = new Child(); // caller\n    d.act(1); // caller\n    d.act(); // caller\n    d.act(0); // caller\n    d.act(); // caller\n    d.t.左を向く(); // step\n    d.t.前に進む(); // step\n  }\n}\nclass Parent {\n  Turtle t;\n  Parent() {\n    this.t = new Turtle(2, 1); // step\n  }\n  void act(int value) {\n    if (value > 0) {\n      this.t.前に進む(); // step\n    }\n    this.t.右を向く(); // step\n  }\n}\nclass Child extends Parent {\n  void act() {\n    this.t.左を向く(); // step\n    this.t.前に進む(); // step\n  }\n}',
    instrumented:
      "function main() {\nlet d = call(Child)(); registerDisplayRef('d', () => d); \ncall(d.actCount.bind(d), 'value')(1); \ncall(d.actDefault.bind(d))(); \ncall(d.actCount.bind(d), 'value')(0); \ncall(d.actDefault.bind(d))(); \nd.t.左を向く(); // step\nd.t.前に進む(); // step\n}\nclass Parent {\nt = undefined;\nconstructor() {\nthis.t = new Turtle(2, 1); // step\n}\nactCount(value) {\nif (value > 0) {\nthis.t.前に進む(); // step\n}\nthis.t.右を向く(); // step\n}\n}\nclass Child extends Parent {\nactDefault() {\nthis.t.左を向く(); // step\nthis.t.前に進む(); // step\n}\n}\nmain();",
    blanks: [
      {
        id: 'InheritedArgument',
        before: '    d.act(0); // caller',
        after: '    d.act(@[0]@); // caller',
      },
      {
        id: 'Parent',
        before: '    this.t.右を向く(); // step',
        after: '    this.t.@[右を向く]@(); // step',
      },
      {
        id: 'Child',
        before: '    this.t.左を向く(); // step',
        after: '    this.t.@[左を向く]@(); // step',
      },
    ],
    bugs: [
      {
        id: 'InheritedArgument',
        before: '    d.act(0); // caller',
        after: '    d.act(1); // caller',
        kind: 'logical',
      },
      {
        id: 'Parent',
        before: '    this.t.右を向く(); // step',
        after: '    this.t.左を向く(); // step',
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
    id: 'challengeII6DelegatedOverride',
    title: '引数なしの親メソッドから子へ到達する',
    courseId: 'tuBeginner2',
    lectureIndex: 5,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Parent d = new Child(); // caller\n    d.act(); // caller\n    d.act(0); // caller\n    d.act(); // caller\n  }\n}\nclass Parent {\n  Turtle t;\n  Parent() {\n    this.t = new Turtle(2, 2); // step\n  }\n  void act() {\n    this.act(1); // caller\n    this.t.右を向く(); // step\n  }\n  void act(int value) {\n    this.t.前に進む(); // step\n  }\n}\nclass Child extends Parent {\n  void act(int value) {\n    if (value > 0) {\n      this.t.左を向く(); // step\n    }\n    this.t.前に進む(); // step\n    this.t.右を向く(); // step\n  }\n}',
    instrumented:
      "function main() {\nlet d = call(Child)(); registerDisplayRef('d', () => d); \ncall(d.actDefault.bind(d))(); \ncall(d.actCount.bind(d), 'value')(0); \ncall(d.actDefault.bind(d))(); \n}\nclass Parent {\nt = undefined;\nconstructor() {\nthis.t = new Turtle(2, 2); // step\n}\nactDefault() {\ncall(this.actCount.bind(this), 'value')(1); \nthis.t.右を向く(); // step\n}\nactCount(value) {\nthis.t.前に進む(); // step\n}\n}\nclass Child extends Parent {\nactCount(value) {\nif (value > 0) {\nthis.t.左を向く(); // step\n}\nthis.t.前に進む(); // step\nthis.t.右を向く(); // step\n}\n}\nmain();",
    blanks: [
      {
        id: 'Dynamic',
        before: '    Parent d = new Child(); // caller',
        after: '    Parent d = new @[Child]@(); // caller',
      },
      {
        id: 'Delegate',
        before: '    this.act(1); // caller',
        after: '    this.act(@[1]@); // caller',
      },
      {
        id: 'ChildCondition',
        before: '    if (value > 0) {',
        after: '    if (value @[>]@ 0) {',
      },
    ],
    bugs: [
      {
        id: 'Dynamic',
        before: '    Parent d = new Child(); // caller',
        after: '    Parent d = new Parent(); // caller',
        kind: 'logical',
      },
      {
        id: 'Delegate',
        before: '    this.act(1); // caller',
        after: '    this.act(0); // caller',
        kind: 'logical',
      },
      {
        id: 'ChildCondition',
        before: '    if (value > 0) {',
        after: '    if (value == 0) {',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII6ChosenSuperSignature',
    title: 'superで引数のある親の動作を選ぶ',
    courseId: 'tuBeginner2',
    lectureIndex: 5,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Child d = new Child(); // caller\n    d.act(); // caller\n    d.act(1); // caller\n    d.act(); // caller\n  }\n}\nclass Parent {\n  Turtle t;\n  Parent() {\n    this.t = new Turtle(3, 2); // step\n  }\n  void act() {\n    this.t.左を向く(); // step\n    this.t.前に進む(); // step\n  }\n  void act(int value) {\n    if (value == 1) {\n      this.t.右を向く(); // step\n    }\n    this.t.前に進む(); // step\n  }\n}\nclass Child extends Parent {\n  void act() {\n    super.act(1); // caller\n    this.t.左を向く(); // step\n    this.t.前に進む(); // step\n  }\n}',
    instrumented:
      "function main() {\nlet d = call(Child)(); registerDisplayRef('d', () => d); \ncall(d.actDefault.bind(d))(); \ncall(d.actCount.bind(d), 'value')(1); \ncall(d.actDefault.bind(d))(); \n}\nclass Parent {\nt = undefined;\nconstructor() {\nthis.t = new Turtle(3, 2); // step\n}\nactDefault() {\nthis.t.左を向く(); // step\nthis.t.前に進む(); // step\n}\nactCount(value) {\nif (value == 1) {\nthis.t.右を向く(); // step\n}\nthis.t.前に進む(); // step\n}\n}\nclass Child extends Parent {\nactDefault() {\ncall(super.actCount.bind(this), 'value')(1); \nthis.t.左を向く(); // step\nthis.t.前に進む(); // step\n}\n}\nmain();",
    blanks: [
      {
        id: 'SuperArgument',
        before: '    super.act(1); // caller',
        after: '    super.act(@[1]@); // caller',
      },
      {
        id: 'SuperChoice',
        before: '    super.act(1); // caller',
        after: '    super.@[act(1)]@; // caller',
      },
      {
        id: 'ParentCondition',
        before: '    if (value == 1) {',
        after: '    if (value @[==]@ 1) {',
      },
    ],
    bugs: [
      {
        id: 'SuperArgument',
        before: '    super.act(1); // caller',
        after: '    super.act(0); // caller',
        kind: 'logical',
      },
      {
        id: 'SuperChoice',
        before: '    super.act(1); // caller',
        after: '    super.act(); // caller',
        kind: 'logical',
      },
      {
        id: 'ParentCondition',
        before: '    if (value == 1) {',
        after: '    if (value != 1) {',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII6ArrayOrScalar',
    title: '配列と一つの数を受け取る',
    courseId: 'tuBeginner2',
    lectureIndex: 5,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Dial d = new Dial(); // caller\n    int[] values = {1, 2}; // step\n    d.load(values); // caller\n    d.move(); // caller\n    d.load(1); // caller\n    d.move(); // caller\n    values[0] = 0; // step\n    d.load(values); // caller\n    d.move(); // caller\n  }\n}\nclass Dial {\n  Turtle t;\n  int amount;\n  Dial() {\n    this.t = new Turtle(2, 2); // step\n    this.amount = 0; // step\n  }\n  void load(int value) {\n    this.amount = value; // step\n  }\n  void load(int[] values) {\n    this.amount = values[0] + values[1]; // step\n  }\n  void move() {\n    if (this.amount > 1) {\n      this.t.右を向く(); // step\n    }\n    this.t.前に進む(); // step\n  }\n}',
    instrumented:
      "function main() {\nlet d = call(Dial)(); registerDisplayRef('d', () => d); \nlet values = [1, 2]; registerDisplayRef('values', () => values); // step\ncall(d.loadArray.bind(d), 'values')(values); \ncall(d.move.bind(d))(); \ncall(d.loadScalar.bind(d), 'value')(1); \ncall(d.move.bind(d))(); \nvalues[0] = 0; // step\ncall(d.loadArray.bind(d), 'values')(values); \ncall(d.move.bind(d))(); \n}\nclass Dial {\nt = undefined;\namount = 0;\nconstructor() {\nthis.t = new Turtle(2, 2); // step\nthis.amount = 0; // step\n}\nloadScalar(value) {\nthis.amount = value; // step\n}\nloadArray(values) {\nthis.amount = values[0] + values[1]; // step\n}\nmove() {\nif (this.amount > 1) {\nthis.t.右を向く(); // step\n}\nthis.t.前に進む(); // step\n}\n}\nmain();",
    blanks: [
      {
        id: 'ArrayUse',
        before: '    this.amount = values[0] + values[1]; // step',
        after: '    this.amount = values[0] @[+]@ values[1]; // step',
      },
      {
        id: 'Scalar',
        before: '    d.load(1); // caller',
        after: '    d.load(@[1]@); // caller',
      },
      {
        id: 'ArrayChange',
        before: '    values[0] = 0; // step',
        after: '    values[0] = @[0;]@ // step',
      },
    ],
    bugs: [
      {
        id: 'ArrayUse',
        before: '    this.amount = values[0] + values[1]; // step',
        after: '    this.amount = values[0] - values[1]; // step',
        kind: 'logical',
      },
      {
        id: 'Scalar',
        before: '    d.load(1); // caller',
        after: '    d.load(2); // caller',
        kind: 'logical',
      },
      {
        id: 'ArrayChange',
        before: '    values[0] = 0; // step',
        after: '    values[0] = -2; // step',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII6ArgumentOrder',
    title: '同じ個数でも引数の型の順で選ぶ',
    courseId: 'tuBeginner2',
    lectureIndex: 5,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Turtle a = new Turtle(2, 2); // step\n    Turtle b = new Turtle(4, 2, "R"); // step\n    Order.act(1, a); // caller\n    Order.act(b, 1); // caller\n    Order.act(0, b); // caller\n    Order.act(a, 0); // caller\n    a.前に進む(); // step\n    b.後に戻る(); // step\n  }\n}\nclass Order {\n  static void act(int value, Turtle target) {\n    if (value == 1) {\n      target.右を向く(); // step\n    }\n    target.前に進む(); // step\n  }\n  static void act(Turtle target, int value) {\n    target.前に進む(); // step\n    if (value == 1) {\n      target.左を向く(); // step\n    }\n  }\n}',
    instrumented:
      "function main() {\nlet a = new Turtle(2, 2); registerDisplayRef('a', () => a); // step\nlet b = new Turtle(4, 2, \"R\"); registerDisplayRef('b', () => b); // step\ncall(Order.firstCount.bind(Order), 'value', 'target')(1, a); \ncall(Order.firstTurtle.bind(Order), 'target', 'value')(b, 1); \ncall(Order.firstCount.bind(Order), 'value', 'target')(0, b); \ncall(Order.firstTurtle.bind(Order), 'target', 'value')(a, 0); \na.前に進む(); // step\nb.後に戻る(); // step\n}\nclass Order {\nstatic firstCount(value, target) {\nif (value == 1) {\ntarget.右を向く(); // step\n}\ntarget.前に進む(); // step\n}\nstatic firstTurtle(target, value) {\ntarget.前に進む(); // step\nif (value == 1) {\ntarget.左を向く(); // step\n}\n}\n}\nmain();",
    blanks: [
      {
        id: 'Order',
        before: '    Order.act(1, a); // caller',
        after: '    Order.@[act(1, a)]@; // caller',
      },
      {
        id: 'FirstCondition',
        before: '    if (value == 1) {\n      target.右を向く(); // step',
        after: '    if (value @[==]@ 1) {\n      target.右を向く(); // step',
      },
      {
        id: 'SecondCondition',
        before: '    if (value == 1) {\n      target.左を向く(); // step',
        after: '    if (value @[==]@ 1) {\n      target.左を向く(); // step',
      },
    ],
    bugs: [
      {
        id: 'Order',
        before: '    Order.act(1, a); // caller',
        after: '    Order.act(a, 1); // caller',
        kind: 'logical',
      },
      {
        id: 'FirstCondition',
        before: '    if (value == 1) {\n      target.右を向く(); // step',
        after: '    if (value != 1) {\n      target.右を向く(); // step',
        kind: 'logical',
      },
      {
        id: 'SecondCondition',
        before: '    if (value == 1) {\n      target.左を向く(); // step',
        after: '    if (value != 1) {\n      target.左を向く(); // step',
        kind: 'logical',
      },
    ],
  },
];
