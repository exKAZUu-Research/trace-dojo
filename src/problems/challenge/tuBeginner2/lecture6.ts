import type { ChallengeBase } from '../types';

export const lecture6: ChallengeBase[] = [
  {
    id: 'challengeII6StoredDefault',
    title: '引数なしの呼び出しが保存値を使う',
    courseId: 'tuBeginner2',
    lectureIndex: 5,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Dial d = new Dial();\n    d.act();\n    d.amount = 0;\n    d.act();\n    d.act(1);\n    d.amount = 2;\n    d.act();\n  }\n}\nclass Dial {\n  Turtle t;\n  int amount;\n  Dial() {\n    this.t = new Turtle(2, 2);\n    this.amount = 1;\n  }\n  void act() {\n    this.act(this.amount);\n  }\n  void act(int value) {\n    if (value > 0) {\n      this.t.前に進む();\n    }\n    this.t.右を向く();\n  }\n}',
    blanks: [
      {
        id: 'Delegate',
        before: '    this.act(this.amount);',
        after: '    this.act(@[this.amount]@);',
      },
      {
        id: 'Argument',
        before: '    d.act(1);',
        after: '    d.act(@[1]@);',
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
        before: '    this.act(this.amount);',
        after: '    this.act(0);',
        kind: 'logical',
      },
      {
        id: 'Argument',
        before: '    d.act(1);',
        after: '    d.act(0);',
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
    java: 'public class Main {\n  public static void main(String[] args) {\n    Dial d = new Dial();\n    d.set(1);\n    d.set(true);\n    d.move();\n    d.set(false);\n    d.move();\n    d.set(0);\n    d.move();\n  }\n}\nclass Dial {\n  Turtle t;\n  int count;\n  boolean right;\n  Dial() {\n    this.t = new Turtle(2, 2);\n    this.count = 0;\n    this.right = false;\n  }\n  void set(int value) {\n    this.count = value;\n  }\n  void set(boolean value) {\n    this.right = value;\n  }\n  void move() {\n    if (this.right) {\n      this.t.右を向く();\n    }\n    if (this.count > 0) {\n      this.t.前に進む();\n    }\n  }\n}',
    blanks: [
      {
        id: 'Boolean',
        before: '    d.set(true);',
        after: '    d.set(@[true]@);',
      },
      {
        id: 'Numeric',
        before: '    this.count = value;',
        after: '    this.count = @[value]@;',
      },
      {
        id: 'Mode',
        before: '    this.right = value;',
        after: '    this.right = @[value]@;',
      },
    ],
    bugs: [
      {
        id: 'Boolean',
        before: '    d.set(true);',
        after: '    d.set(false);',
        kind: 'logical',
      },
      {
        id: 'Numeric',
        before: '    this.count = value;',
        after: '    this.count = 0;',
        kind: 'logical',
      },
      {
        id: 'Mode',
        before: '    this.right = value;',
        after: '    this.right = !value;',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII6OneAndTwoFields',
    title: '引数の数によって更新するフィールドが違う',
    courseId: 'tuBeginner2',
    lectureIndex: 5,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Dial d = new Dial();\n    d.change(2, 1);\n    d.move();\n    d.change(0);\n    d.move();\n    d.change(1, 2);\n    d.move();\n  }\n}\nclass Dial {\n  Turtle t;\n  int left;\n  int right;\n  Dial() {\n    this.t = new Turtle(2, 2);\n    this.left = 0;\n    this.right = 0;\n  }\n  void change(int value) {\n    this.left = value;\n  }\n  void change(int first, int second) {\n    this.left = first;\n    this.right = second;\n  }\n  void move() {\n    if (this.left > this.right) {\n      this.t.右を向く();\n    } else {\n      this.t.左を向く();\n    }\n    this.t.前に進む();\n  }\n}',
    blanks: [
      {
        id: 'Pair',
        before: '    this.right = second;',
        after: '    this.right = @[second]@;',
      },
      {
        id: 'One',
        before: '    this.left = value;',
        after: '    this.left = @[value]@;',
      },
      {
        id: 'Select',
        before: '    d.change(1, 2);',
        after: '    d.change(@[1, 2]@);',
      },
    ],
    bugs: [
      {
        id: 'Pair',
        before: '    this.right = second;',
        after: '    this.right = first;',
        kind: 'logical',
      },
      {
        id: 'One',
        before: '    this.left = value;',
        after: '    this.left = value + 2;',
        kind: 'logical',
      },
      {
        id: 'Select',
        before: '    d.change(1, 2);',
        after: '    d.change(2, 1);',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII6ObjectOrDefault',
    title: '引数の亀と保存された亀を使い分ける',
    courseId: 'tuBeginner2',
    lectureIndex: 5,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Turtle a = new Turtle(2, 2);\n    Turtle b = new Turtle(4, 2, "R");\n    Dial d = new Dial(a);\n    d.draw();\n    d.draw(b);\n    a.後に戻る();\n    d.draw();\n    b.左を向く();\n  }\n}\nclass Dial {\n  Turtle saved;\n  Dial(Turtle initial) {\n    this.saved = initial;\n  }\n  void draw() {\n    this.draw(this.saved);\n  }\n  void draw(Turtle target) {\n    target.右を向く();\n    target.前に進む();\n  }\n}',
    blanks: [
      {
        id: 'Target',
        before: '    d.draw(b);',
        after: '    d.draw@[(b)]@;',
      },
      {
        id: 'Saved',
        before: '    Dial d = new Dial(a);',
        after: '    Dial d = new Dial@[(a)]@;',
      },
      {
        id: 'Turn',
        before: '    target.右を向く();',
        after: '    target.@[右を向く]@();',
      },
    ],
    bugs: [
      {
        id: 'Target',
        before: '    d.draw(b);',
        after: '    d.draw(a);',
        kind: 'logical',
      },
      {
        id: 'Saved',
        before: '    Dial d = new Dial(a);',
        after: '    Dial d = new Dial(b);',
        kind: 'logical',
      },
      {
        id: 'Turn',
        before: '    target.右を向く();',
        after: '    target.左を向く();',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII6TextAndCount',
    title: '文字列と整数のオーバーロード',
    courseId: 'tuBeginner2',
    lectureIndex: 5,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Dial d = new Dial();\n    d.command(1);\n    d.move();\n    d.command("turn");\n    d.move();\n    d.command(0);\n    d.move();\n    d.command("turn");\n  }\n}\nclass Dial {\n  Turtle t;\n  int count;\n  Dial() {\n    this.t = new Turtle(2, 2);\n    this.count = 0;\n  }\n  void command(int value) {\n    this.count = value;\n  }\n  void command(String text) {\n    this.t.右を向く();\n  }\n  void move() {\n    if (this.count == 1) {\n      this.t.前に進む();\n    }\n    this.t.左を向く();\n  }\n}',
    blanks: [
      {
        id: 'Count',
        before: '    d.command(1);',
        after: '    d.command(@[1]@);',
      },
      {
        id: 'TextAction',
        before: '    this.t.右を向く();',
        after: '    this.t.@[右を向く]@();',
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
        before: '    d.command(1);',
        after: '    d.command(0);',
        kind: 'logical',
      },
      {
        id: 'TextAction',
        before: '    this.t.右を向く();',
        after: '    this.t.左を向く();',
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
    java: 'public class Main {\n  public static void main(String[] args) {\n    Child d = new Child();\n    d.act(1);\n    d.act();\n    d.act(0);\n    d.act();\n    d.t.左を向く();\n    d.t.前に進む();\n  }\n}\nclass Parent {\n  Turtle t;\n  Parent() {\n    this.t = new Turtle(2, 1);\n  }\n  void act(int value) {\n    if (value > 0) {\n      this.t.前に進む();\n    }\n    this.t.右を向く();\n  }\n}\nclass Child extends Parent {\n  void act() {\n    this.t.左を向く();\n    this.t.前に進む();\n  }\n}',
    blanks: [
      {
        id: 'InheritedArgument',
        before: '    d.act(0);',
        after: '    d.act(@[0]@);',
      },
      {
        id: 'Parent',
        before: '    this.t.右を向く();',
        after: '    this.t.@[右を向く]@();',
      },
      {
        id: 'Child',
        before: '    this.t.左を向く();',
        after: '    this.t.@[左を向く]@();',
      },
    ],
    bugs: [
      {
        id: 'InheritedArgument',
        before: '    d.act(0);',
        after: '    d.act(1);',
        kind: 'logical',
      },
      {
        id: 'Parent',
        before: '    this.t.右を向く();',
        after: '    this.t.左を向く();',
        kind: 'logical',
      },
      {
        id: 'Child',
        before: '    this.t.左を向く();',
        after: '    this.t.右を向く();',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII6DelegatedOverride',
    title: '引数なしの親メソッドから子へ到達する',
    courseId: 'tuBeginner2',
    lectureIndex: 5,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Parent d = new Child();\n    d.act();\n    d.act(0);\n    d.act();\n  }\n}\nclass Parent {\n  Turtle t;\n  Parent() {\n    this.t = new Turtle(2, 2);\n  }\n  void act() {\n    this.act(1);\n    this.t.右を向く();\n  }\n  void act(int value) {\n    this.t.前に進む();\n  }\n}\nclass Child extends Parent {\n  void act(int value) {\n    if (value > 0) {\n      this.t.左を向く();\n    }\n    this.t.前に進む();\n    this.t.右を向く();\n  }\n}',
    blanks: [
      {
        id: 'Dynamic',
        before: '    Parent d = new Child();',
        after: '    Parent d = new @[Child]@();',
      },
      {
        id: 'Delegate',
        before: '    this.act(1);',
        after: '    this.act(@[1]@);',
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
        before: '    Parent d = new Child();',
        after: '    Parent d = new Parent();',
        kind: 'logical',
      },
      {
        id: 'Delegate',
        before: '    this.act(1);',
        after: '    this.act(0);',
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
    java: 'public class Main {\n  public static void main(String[] args) {\n    Child d = new Child();\n    d.act();\n    d.act(1);\n    d.act();\n  }\n}\nclass Parent {\n  Turtle t;\n  Parent() {\n    this.t = new Turtle(3, 2);\n  }\n  void act() {\n    this.t.左を向く();\n    this.t.前に進む();\n  }\n  void act(int value) {\n    if (value == 1) {\n      this.t.右を向く();\n    }\n    this.t.前に進む();\n  }\n}\nclass Child extends Parent {\n  void act() {\n    super.act(1);\n    this.t.左を向く();\n    this.t.前に進む();\n  }\n}',
    blanks: [
      {
        id: 'SuperArgument',
        before: '    super.act(1);',
        after: '    super.act(@[1]@);',
      },
      {
        id: 'ChildTurn',
        before: '    super.act(1);\n    this.t.左を向く();',
        after: '    super.act(1);\n    this.t.@[左を向く]@();',
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
        before: '    super.act(1);',
        after: '    super.act(0);',
        kind: 'logical',
      },
      {
        id: 'ChildTurn',
        before: '    super.act(1);\n    this.t.左を向く();',
        after: '    super.act(1);\n    this.t.右を向く();',
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
    java: 'public class Main {\n  public static void main(String[] args) {\n    Dial d = new Dial();\n    int[] values = {1, 2};\n    d.load(values);\n    d.move();\n    d.load(1);\n    d.move();\n    values[0] = 0;\n    d.load(values);\n    d.move();\n  }\n}\nclass Dial {\n  Turtle t;\n  int amount;\n  Dial() {\n    this.t = new Turtle(2, 2);\n    this.amount = 0;\n  }\n  void load(int value) {\n    this.amount = value;\n  }\n  void load(int[] values) {\n    this.amount = values[0] + values[1];\n  }\n  void move() {\n    if (this.amount > 1) {\n      this.t.右を向く();\n    }\n    this.t.前に進む();\n  }\n}',
    blanks: [
      {
        id: 'ArrayUse',
        before: '    this.amount = values[0] + values[1];',
        after: '    this.amount = values[0] @[+]@ values[1];',
      },
      {
        id: 'Scalar',
        before: '    d.load(1);',
        after: '    d.load(@[1]@);',
      },
      {
        id: 'ArrayChange',
        before: '    values[0] = 0;',
        after: '    values[0] = @[0;]@',
      },
    ],
    bugs: [
      {
        id: 'ArrayUse',
        before: '    this.amount = values[0] + values[1];',
        after: '    this.amount = values[0] - values[1];',
        kind: 'logical',
      },
      {
        id: 'Scalar',
        before: '    d.load(1);',
        after: '    d.load(2);',
        kind: 'logical',
      },
      {
        id: 'ArrayChange',
        before: '    values[0] = 0;',
        after: '    values[0] = -2;',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII6ArgumentOrder',
    title: '同じ個数でも引数の型の順で選ぶ',
    courseId: 'tuBeginner2',
    lectureIndex: 5,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Turtle a = new Turtle(2, 2);\n    Turtle b = new Turtle(4, 2, "R");\n    Order.act(1, a);\n    Order.act(b, 1);\n    Order.act(0, b);\n    Order.act(a, 0);\n    a.前に進む();\n    b.後に戻る();\n  }\n}\nclass Order {\n  static void act(int value, Turtle target) {\n    if (value == 1) {\n      target.右を向く();\n    }\n    target.前に進む();\n  }\n  static void act(Turtle target, int value) {\n    target.前に進む();\n    if (value == 1) {\n      target.左を向く();\n    }\n  }\n}',
    blanks: [
      {
        id: 'Order',
        before: '    Order.act(1, a);',
        after: '    Order.@[act(1, a)]@;',
      },
      {
        id: 'FirstCondition',
        before: '    if (value == 1) {\n      target.右を向く();',
        after: '    if (value @[==]@ 1) {\n      target.右を向く();',
      },
      {
        id: 'SecondCondition',
        before: '    if (value == 1) {\n      target.左を向く();',
        after: '    if (value @[==]@ 1) {\n      target.左を向く();',
      },
    ],
    bugs: [
      {
        id: 'Order',
        before: '    Order.act(1, a);',
        after: '    Order.act(a, 1);',
        kind: 'logical',
      },
      {
        id: 'FirstCondition',
        before: '    if (value == 1) {\n      target.右を向く();',
        after: '    if (value != 1) {\n      target.右を向く();',
        kind: 'logical',
      },
      {
        id: 'SecondCondition',
        before: '    if (value == 1) {\n      target.左を向く();',
        after: '    if (value != 1) {\n      target.左を向く();',
        kind: 'logical',
      },
    ],
  },
];
