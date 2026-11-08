import type { CorrectProblem } from '../types';

export const lecture4: CorrectProblem[] = [
  {
    id: 'challengeII4ConstructionTotal',
    title: '作った後で共有の個数を読む',
    courseId: 'tuBeginner2',
    lectureIndex: 3,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Shared a = new Shared(2);\n    a.mark();\n    Shared b = new Shared(4);\n    a.mark();\n    b.mark();\n    b.t.左を向く();\n    b.t.前に進む();\n  }\n}\nclass Shared {\n  Turtle t;\n  static int total = 0;\n  Shared(int x) {\n    this.t = new Turtle(x, 2);\n    Shared.total++;\n  }\n\n  void mark() {\n    if (Shared.total == 2) {\n      this.t.右を向く();\n    }\n    this.t.前に進む();\n  }\n\n}',
  },
  {
    id: 'challengeII4CommonBudget',
    title: '二つのインスタンスで残りを分ける',
    courseId: 'tuBeginner2',
    lectureIndex: 3,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Shared a = new Shared(2);\n    Shared b = new Shared(4);\n    a.use();\n    b.use();\n    a.use();\n    b.use();\n  }\n}\nclass Shared {\n  Turtle t;\n  static int left = 3;\n  Shared(int x) {\n    this.t = new Turtle(x, 2);\n    this.t.右を向く();\n  }\n\n  void use() {\n    if (Shared.left > 0) {\n      this.t.前に進む();\n      Shared.left--;\n    }\n    this.t.左を向く();\n  }\n\n}',
  },
  {
    id: 'challengeII4DefaultSnapshot',
    title: '共有の初期値をコピーした時点',
    courseId: 'tuBeginner2',
    lectureIndex: 3,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Shared a = new Shared(2);\n    Shared.defaultMode = 2;\n    Shared b = new Shared(4);\n    a.move();\n    b.move();\n    a.move();\n  }\n}\nclass Shared {\n  Turtle t;\n  static int defaultMode = 1;\n  int mode;\n  Shared(int x) {\n    this.t = new Turtle(x, 2);\n    this.mode = Shared.defaultMode;\n  }\n\n  void move() {\n    if (this.mode == 1) {\n      this.t.右を向く();\n    } else {\n      this.t.左を向く();\n    }\n    this.t.前に進む();\n  }\n\n}',
  },
  {
    id: 'challengeII4ResetShared',
    title: '共有カウンタをリセットする',
    courseId: 'tuBeginner2',
    lectureIndex: 3,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Shared a = new Shared(2);\n    Shared b = new Shared(4);\n    a.act();\n    b.act();\n    Shared.reset();\n    b.act();\n  }\n}\nclass Shared {\n  Turtle t;\n  static int count = 0;\n  Shared(int x) {\n    this.t = new Turtle(x, 2);\n    this.t.右を向く();\n  }\n\n  static void reset() {\n    Shared.count = 0;\n  }\n  void act() {\n    Shared.count++;\n    if (Shared.count == 1) {\n      this.t.左を向く();\n    }\n    this.t.前に進む();\n  }\n\n}',
  },
  {
    id: 'challengeII4PairUtility',
    title: '二つの亀を静的メソッドへ渡す',
    courseId: 'tuBeginner2',
    lectureIndex: 3,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Turtle a = new Turtle(2, 2);\n    Turtle b = new Turtle(4, 2, "B");\n    Utility.cross(a, b);\n    a.前に進む();\n    b.後に戻る();\n    Utility.cross(b, a);\n  }\n}\nclass Utility {\n  static void cross(Turtle first, Turtle second) {\n    first.右を向く();\n    second.左を向く();\n    first.前に進む();\n    second.前に進む();\n  }\n}',
  },
  {
    id: 'challengeII4SharedMode',
    title: '一方が変えたモードをもう一方で使う',
    courseId: 'tuBeginner2',
    lectureIndex: 3,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Shared a = new Shared(2);\n    Shared b = new Shared(4);\n    a.move();\n    a.flip();\n    b.move();\n    b.flip();\n    a.move();\n  }\n}\nclass Shared {\n  Turtle t;\n  static boolean right = true;\n  Shared(int x) {\n    this.t = new Turtle(x, 2);\n    this.t.前に進む();\n  }\n\n  void flip() {\n    Shared.right = !Shared.right;\n  }\n  void move() {\n    if (Shared.right) {\n      this.t.右を向く();\n    } else {\n      this.t.左を向く();\n    }\n    this.t.前に進む();\n  }\n\n}',
  },
  {
    id: 'challengeII4LocalAndGlobal',
    title: '個別の回数と全体の回数',
    courseId: 'tuBeginner2',
    lectureIndex: 3,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Shared a = new Shared(2);\n    Shared b = new Shared(4);\n    a.act();\n    b.act();\n    a.act();\n  }\n}\nclass Shared {\n  Turtle t;\n  static int total = 0;\n  int own;\n  Shared(int x) {\n    this.t = new Turtle(x, 2);\n    this.own = 0;\n  }\n\n  void act() {\n    this.own++;\n    Shared.total++;\n    if (this.own == Shared.total) {\n      this.t.右を向く();\n    }\n    this.t.前に進む();\n  }\n\n}',
  },
  {
    id: 'challengeII4OffsetReturn',
    title: '共有の差分を使った静的計算',
    courseId: 'tuBeginner2',
    lectureIndex: 3,
    java: 'public class Main {\n  public static void main(String[] args) {\n    int first = Offset.position(1);\n    Turtle a = new Turtle(first, 2);\n    Offset.shift = 2;\n    int second = Offset.position(1);\n    Turtle b = new Turtle(second, 2, "R");\n    a.前に進む();\n    b.右を向く();\n    b.前に進む();\n    a.左を向く();\n    a.前に進む();\n    b.左を向く();\n    b.前に進む();\n  }\n}\nclass Offset {\n  static int shift = 1;\n  static int position(int origin) {\n    return origin + Offset.shift;\n  }\n}',
  },
  {
    id: 'challengeII4IssuedNumber',
    title: '生成順の番号をインスタンスへ保存',
    courseId: 'tuBeginner2',
    lectureIndex: 3,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Shared a = new Shared(2);\n    Shared b = new Shared(4);\n    a.mark();\n    b.mark();\n    a.mark();\n  }\n}\nclass Shared {\n  Turtle t;\n  static int sequence = 0;\n  int number;\n  Shared(int x) {\n    this.t = new Turtle(x, 2);\n    this.number = Shared.sequence;\n    Shared.sequence++;\n  }\n\n  void mark() {\n    if (this.number == 0) {\n      this.t.右を向く();\n    } else {\n      this.t.左を向く();\n    }\n    this.t.前に進む();\n  }\n\n}',
  },
  {
    id: 'challengeII4ReadTiming',
    title: '静的な値を保存してから更新',
    courseId: 'tuBeginner2',
    lectureIndex: 3,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Shared a = new Shared(2);\n    Shared b = new Shared(4);\n    int saved = Shared.count;\n    Shared.increment();\n    a.compare(saved);\n    b.compare(Shared.count);\n    Shared.increment();\n    b.compare(saved);\n  }\n}\nclass Shared {\n  Turtle t;\n  static int count = 1;\n  Shared(int x) {\n    this.t = new Turtle(x, 2);\n    this.t.右を向く();\n  }\n\n  static void increment() {\n    Shared.count++;\n  }\n  void compare(int old) {\n    if (old < Shared.count) {\n      this.t.左を向く();\n    }\n    this.t.前に進む();\n  }\n\n}',
  },
];
