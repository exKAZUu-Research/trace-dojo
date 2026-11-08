import type { CorrectProblem } from '../types';

export const lecture5: CorrectProblem[] = [
  {
    id: 'challengeII5ProtectedCounter',
    title: '継承した状態を子クラスから変える',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Boost b = new Boost();\n    b.act();\n    b.boost();\n    b.act();\n    b.act();\n  }\n}\nclass Base {\n  protected Turtle t;\n  protected int count;\n  Base() {\n    this.t = new Turtle(2, 2);\n    this.count = 0;\n  }\n  void act() {\n    this.count++;\n    if (this.count > 2) {\n      this.t.右を向く();\n    }\n    this.t.前に進む();\n  }\n}\nclass Boost extends Base {\n  void boost() {\n    this.count += 2;\n  }\n}',
  },
  {
    id: 'challengeII5ReverseOrder',
    title: '移動と回転の順をオーバーライドする',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Base a = new Base();\n    Base b = new Reverse();\n    a.act();\n    b.act();\n    a.act();\n    b.act();\n  }\n}\nclass Base {\n  Turtle t;\n  Base() {\n    this.t = new Turtle(2, 2);\n  }\n  void act() {\n    this.t.右を向く();\n    this.t.前に進む();\n  }\n}\nclass Reverse extends Base {\n  void act() {\n    this.t.前に進む();\n    this.t.右を向く();\n  }\n}',
  },
  {
    id: 'challengeII5SuperSuffix',
    title: '親の動作の後で一歩戻る',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Base a = new Returner();\n    a.act();\n    a.t.左を向く();\n    a.act();\n    a.t.前に進む();\n  }\n}\nclass Base {\n  Turtle t;\n  Base() {\n    this.t = new Turtle(2, 2);\n  }\n  void act() {\n    this.t.前に進む();\n    this.t.右を向く();\n    this.t.前に進む();\n  }\n}\nclass Returner extends Base {\n  void act() {\n    super.act();\n    this.t.後に戻る();\n  }\n}',
  },
  {
    id: 'challengeII5ConstructorTransform',
    title: '親へ渡す値を子で変える',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Shifted a = new Shifted(1);\n    a.act();\n    a.act();\n    a.t.左を向く();\n    a.act();\n  }\n}\nclass Base {\n  Turtle t;\n  int mode;\n  Base(int value) {\n    this.t = new Turtle(2, 2);\n    this.mode = value;\n  }\n  void act() {\n    if (this.mode == 2) {\n      this.t.右を向く();\n    }\n    this.t.前に進む();\n    this.mode--;\n  }\n}\nclass Shifted extends Base {\n  Shifted(int value) {\n    super(value + 1);\n    this.mode++;\n  }\n}',
  },
  {
    id: 'challengeII5TemplateDispatch',
    title: '親の組み合わせ動作から子を呼ぶ',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Base a = new Alternating();\n    a.pair();\n    a.pair();\n  }\n}\nclass Base {\n  Turtle t;\n  int count;\n  Base() {\n    this.t = new Turtle(2, 2);\n    this.count = 0;\n  }\n  void unit() {\n    this.t.前に進む();\n  }\n  void pair() {\n    this.unit();\n    this.unit();\n  }\n}\nclass Alternating extends Base {\n  void unit() {\n    this.count++;\n    if (this.count % 2 == 0) {\n      this.t.右を向く();\n    }\n    this.t.前に進む();\n  }\n}',
  },
  {
    id: 'challengeII5ReboundBase',
    title: '同じ親型の名前で異なる子を呼ぶ',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Left a = new Left();\n    Right b = new Right();\n    Base selected = a;\n    selected.act();\n    selected = b;\n    selected.act();\n    selected = a;\n    selected.act();\n    b.act();\n  }\n}\nclass Base {\n  Turtle t;\n  Base() {\n    this.t = new Turtle(2, 2);\n  }\n  void act() {\n    this.t.前に進む();\n  }\n}\nclass Left extends Base {\n  void act() {\n    this.t.左を向く();\n    this.t.前に進む();\n  }\n}\nclass Right extends Base {\n  void act() {\n    this.t.前に進む();\n    this.t.右を向く();\n  }\n}',
  },
  {
    id: 'challengeII5ArrayDispatch',
    title: '配列から選んだ子の動作',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Base a = new Corner();\n    Base b = new Retreat();\n    Base[] choices = {b, a};\n    Base first = choices[0];\n    Base second = choices[1];\n    first.act();\n    second.act();\n    first.act();\n  }\n}\nclass Base {\n  Turtle t;\n  Base() {\n    this.t = new Turtle(3, 3);\n  }\n  void act() {\n    this.t.前に進む();\n  }\n}\nclass Corner extends Base {\n  void act() {\n    this.t.右を向く();\n    this.t.前に進む();\n    this.t.左を向く();\n  }\n}\nclass Retreat extends Base {\n  void act() {\n    this.t.後に戻る();\n    this.t.左を向く();\n  }\n}',
  },
  {
    id: 'challengeII5MixedHelpers',
    title: '継承する補助動作と上書きする補助動作',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Base a = new Changed();\n    a.draw();\n    a.draw();\n    a.t.右を向く();\n  }\n}\nclass Base {\n  Turtle t;\n  Base() {\n    this.t = new Turtle(2, 2);\n  }\n  void first() {\n    this.t.前に進む();\n    this.t.右を向く();\n  }\n  void second() {\n    this.t.前に進む();\n  }\n  void draw() {\n    this.first();\n    this.second();\n  }\n}\nclass Changed extends Base {\n  void second() {\n    this.t.左を向く();\n    this.t.前に進む();\n  }\n}',
  },
  {
    id: 'challengeII5SuperChain',
    title: '三段階のsuper呼び出し',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Base a = new Last();\n    a.act();\n    a.t.右を向く();\n    a.act();\n    a.t.後に戻る();\n  }\n}\nclass Base {\n  Turtle t;\n  Base() {\n    this.t = new Turtle(2, 2);\n  }\n  void act() {\n    this.t.前に進む();\n    this.t.右を向く();\n  }\n}\nclass Middle extends Base {\n  void act() {\n    super.act();\n    this.t.前に進む();\n  }\n}\nclass Last extends Middle {\n  void act() {\n    super.act();\n    this.t.左を向く();\n  }\n}',
  },
  {
    id: 'challengeII5StateOverride',
    title: '状態によって親の動作を選ぶ',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Base a = new Alternating();\n    a.act();\n    a.act();\n    a.act();\n    a.act();\n  }\n}\nclass Base {\n  Turtle t;\n  int count;\n  Base() {\n    this.t = new Turtle(2, 2);\n    this.count = 0;\n  }\n  void act() {\n    this.t.前に進む();\n  }\n}\nclass Alternating extends Base {\n  void act() {\n    this.count++;\n    if (this.count % 2 == 1) {\n      super.act();\n    } else {\n      this.t.右を向く();\n      this.t.前に進む();\n    }\n  }\n}',
  },
];
