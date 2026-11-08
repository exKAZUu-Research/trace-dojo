import type { CorrectProblem } from '../types';

export const lecture6: CorrectProblem[] = [
  {
    id: 'challengeII6StoredDefault',
    title: '引数なしの呼び出しが保存値を使う',
    courseId: 'tuBeginner2',
    lectureIndex: 5,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Dial d = new Dial();\n    d.act();\n    d.amount = 0;\n    d.act();\n    d.act(1);\n    d.amount = 2;\n    d.act();\n  }\n}\nclass Dial {\n  Turtle t;\n  int amount;\n  Dial() {\n    this.t = new Turtle(2, 2);\n    this.amount = 1;\n  }\n  void act() {\n    this.act(this.amount);\n  }\n  void act(int value) {\n    if (value > 0) {\n      this.t.前に進む();\n    }\n    this.t.右を向く();\n  }\n}',
  },
  {
    id: 'challengeII6BooleanAndNumber',
    title: '論理値と整数で異なる設定',
    courseId: 'tuBeginner2',
    lectureIndex: 5,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Dial d = new Dial();\n    d.set(1);\n    d.set(true);\n    d.move();\n    d.set(false);\n    d.move();\n    d.set(0);\n    d.move();\n  }\n}\nclass Dial {\n  Turtle t;\n  int count;\n  boolean right;\n  Dial() {\n    this.t = new Turtle(2, 2);\n    this.count = 0;\n    this.right = false;\n  }\n  void set(int value) {\n    this.count = value;\n  }\n  void set(boolean value) {\n    this.right = value;\n  }\n  void move() {\n    if (this.right) {\n      this.t.右を向く();\n    }\n    if (this.count > 0) {\n      this.t.前に進む();\n    }\n  }\n}',
  },
  {
    id: 'challengeII6OneAndTwoFields',
    title: '引数の数によって更新するフィールドが違う',
    courseId: 'tuBeginner2',
    lectureIndex: 5,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Dial d = new Dial();\n    d.change(2, 1);\n    d.move();\n    d.change(0);\n    d.move();\n    d.change(1, 2);\n    d.move();\n  }\n}\nclass Dial {\n  Turtle t;\n  int left;\n  int right;\n  Dial() {\n    this.t = new Turtle(2, 2);\n    this.left = 0;\n    this.right = 0;\n  }\n  void change(int value) {\n    this.left = value;\n  }\n  void change(int first, int second) {\n    this.left = first;\n    this.right = second;\n  }\n  void move() {\n    if (this.left > this.right) {\n      this.t.右を向く();\n    } else {\n      this.t.左を向く();\n    }\n    this.t.前に進む();\n  }\n}',
  },
  {
    id: 'challengeII6ObjectOrDefault',
    title: '引数の亀と保存された亀を使い分ける',
    courseId: 'tuBeginner2',
    lectureIndex: 5,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Turtle a = new Turtle(2, 2);\n    Turtle b = new Turtle(4, 2, "R");\n    Dial d = new Dial(a);\n    d.draw();\n    d.draw(b);\n    a.後に戻る();\n    d.draw();\n    b.左を向く();\n  }\n}\nclass Dial {\n  Turtle saved;\n  Dial(Turtle initial) {\n    this.saved = initial;\n  }\n  void draw() {\n    this.draw(this.saved);\n  }\n  void draw(Turtle target) {\n    target.右を向く();\n    target.前に進む();\n  }\n}',
  },
  {
    id: 'challengeII6TextAndCount',
    title: '文字列と整数のオーバーロード',
    courseId: 'tuBeginner2',
    lectureIndex: 5,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Dial d = new Dial();\n    d.command(1);\n    d.move();\n    d.command("turn");\n    d.move();\n    d.command(0);\n    d.move();\n    d.command("turn");\n  }\n}\nclass Dial {\n  Turtle t;\n  int count;\n  Dial() {\n    this.t = new Turtle(2, 2);\n    this.count = 0;\n  }\n  void command(int value) {\n    this.count = value;\n  }\n  void command(String text) {\n    this.t.右を向く();\n  }\n  void move() {\n    if (this.count == 1) {\n      this.t.前に進む();\n    }\n    this.t.左を向く();\n  }\n}',
  },
  {
    id: 'challengeII6InheritedSignature',
    title: '親の引数ありと子の引数なし',
    courseId: 'tuBeginner2',
    lectureIndex: 5,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Child d = new Child();\n    d.act(1);\n    d.act();\n    d.act(0);\n    d.act();\n    d.t.左を向く();\n    d.t.前に進む();\n  }\n}\nclass Parent {\n  Turtle t;\n  Parent() {\n    this.t = new Turtle(2, 1);\n  }\n  void act(int value) {\n    if (value > 0) {\n      this.t.前に進む();\n    }\n    this.t.右を向く();\n  }\n}\nclass Child extends Parent {\n  void act() {\n    this.t.左を向く();\n    this.t.前に進む();\n  }\n}',
  },
  {
    id: 'challengeII6DelegatedOverride',
    title: '引数なしの親メソッドから子へ到達する',
    courseId: 'tuBeginner2',
    lectureIndex: 5,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Parent d = new Child();\n    d.act();\n    d.act(0);\n    d.act();\n  }\n}\nclass Parent {\n  Turtle t;\n  Parent() {\n    this.t = new Turtle(2, 2);\n  }\n  void act() {\n    this.act(1);\n    this.t.右を向く();\n  }\n  void act(int value) {\n    this.t.前に進む();\n  }\n}\nclass Child extends Parent {\n  void act(int value) {\n    if (value > 0) {\n      this.t.左を向く();\n    }\n    this.t.前に進む();\n    this.t.右を向く();\n  }\n}',
  },
  {
    id: 'challengeII6ChosenSuperSignature',
    title: 'superで引数のある親の動作を選ぶ',
    courseId: 'tuBeginner2',
    lectureIndex: 5,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Child d = new Child();\n    d.act();\n    d.act(1);\n    d.act();\n  }\n}\nclass Parent {\n  Turtle t;\n  Parent() {\n    this.t = new Turtle(3, 2);\n  }\n  void act() {\n    this.t.左を向く();\n    this.t.前に進む();\n  }\n  void act(int value) {\n    if (value == 1) {\n      this.t.右を向く();\n    }\n    this.t.前に進む();\n  }\n}\nclass Child extends Parent {\n  void act() {\n    super.act(1);\n    this.t.左を向く();\n    this.t.前に進む();\n  }\n}',
  },
  {
    id: 'challengeII6ArrayOrScalar',
    title: '配列と一つの数を受け取る',
    courseId: 'tuBeginner2',
    lectureIndex: 5,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Dial d = new Dial();\n    int[] values = {1, 2};\n    d.load(values);\n    d.move();\n    d.load(1);\n    d.move();\n    values[0] = 0;\n    d.load(values);\n    d.move();\n  }\n}\nclass Dial {\n  Turtle t;\n  int amount;\n  Dial() {\n    this.t = new Turtle(2, 2);\n    this.amount = 0;\n  }\n  void load(int value) {\n    this.amount = value;\n  }\n  void load(int[] values) {\n    this.amount = values[0] + values[1];\n  }\n  void move() {\n    if (this.amount > 1) {\n      this.t.右を向く();\n    }\n    this.t.前に進む();\n  }\n}',
  },
  {
    id: 'challengeII6ArgumentOrder',
    title: '同じ個数でも引数の型の順で選ぶ',
    courseId: 'tuBeginner2',
    lectureIndex: 5,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Turtle a = new Turtle(2, 2);\n    Turtle b = new Turtle(4, 2, "R");\n    Order.act(1, a);\n    Order.act(b, 1);\n    Order.act(0, b);\n    Order.act(a, 0);\n    a.前に進む();\n    b.後に戻る();\n  }\n}\nclass Order {\n  static void act(int value, Turtle target) {\n    if (value == 1) {\n      target.右を向く();\n    }\n    target.前に進む();\n  }\n  static void act(Turtle target, int value) {\n    target.前に進む();\n    if (value == 1) {\n      target.左を向く();\n    }\n  }\n}',
  },
];
