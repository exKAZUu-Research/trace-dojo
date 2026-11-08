import type { ChallengeBase } from '../types';

export const lecture4: ChallengeBase[] = [
  {
    id: 'challengeII4ConstructionTotal',
    title: '作った後で共有の個数を読む',
    courseId: 'tuBeginner2',
    lectureIndex: 3,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Shared a = new Shared(2);\n    a.mark();\n    Shared b = new Shared(4);\n    a.mark();\n    b.mark();\n    b.t.左を向く();\n    b.t.前に進む();\n  }\n}\nclass Shared {\n  Turtle t;\n  static int total = 0;\n  Shared(int x) {\n    this.t = new Turtle(x, 2);\n    Shared.total++;\n  }\n\n  void mark() {\n    if (Shared.total == 2) {\n      this.t.右を向く();\n    }\n    this.t.前に進む();\n  }\n\n}',
    blanks: [
      {
        id: 'Count',
        before: '    Shared.total++;',
        after: '    Shared.total@[++]@;',
      },
      {
        id: 'Read',
        before: '    if (Shared.total == 2) {',
        after: '    if (Shared.total == @[2]@) {',
      },
      {
        id: 'Later',
        before: '    a.mark();\n    b.mark();',
        after: '    @[a.mark()]@;\n    b.mark();',
      },
    ],
    bugs: [
      {
        id: 'Count',
        before: '    Shared.total++;',
        after: '    Shared.total--;',
        kind: 'logical',
      },
      {
        id: 'Read',
        before: '    if (Shared.total == 2) {',
        after: '    if (Shared.total == 1) {',
        kind: 'logical',
      },
      {
        id: 'Later',
        before: '    a.mark();\n    b.mark();',
        after: '    b.mark();\n    b.mark();',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII4CommonBudget',
    title: '二つのインスタンスで残りを分ける',
    courseId: 'tuBeginner2',
    lectureIndex: 3,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Shared a = new Shared(2);\n    Shared b = new Shared(4);\n    a.use();\n    b.use();\n    a.use();\n    b.use();\n  }\n}\nclass Shared {\n  Turtle t;\n  static int left = 3;\n  Shared(int x) {\n    this.t = new Turtle(x, 2);\n    this.t.右を向く();\n  }\n\n  void use() {\n    if (Shared.left > 0) {\n      this.t.前に進む();\n      Shared.left--;\n    }\n    this.t.左を向く();\n  }\n\n}',
    blanks: [
      {
        id: 'Shared',
        before: '      Shared.left--;',
        after: '      Shared.left@[--]@;',
      },
      {
        id: 'Boundary',
        before: '    if (Shared.left > 0) {',
        after: '    if (Shared.left @[>]@ 0) {',
      },
      {
        id: 'Allowance',
        before: '  static int left = 3;',
        after: '  static int left = @[3]@;',
      },
    ],
    bugs: [
      {
        id: 'Shared',
        before: '      Shared.left--;',
        after: '      Shared.left++;',
        kind: 'logical',
      },
      {
        id: 'Boundary',
        before: '    if (Shared.left > 0) {',
        after: '    if (Shared.left >= 0) {',
        kind: 'logical',
      },
      {
        id: 'Allowance',
        before: '  static int left = 3;',
        after: '  static int left = 2;',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII4DefaultSnapshot',
    title: '共有の初期値をコピーした時点',
    courseId: 'tuBeginner2',
    lectureIndex: 3,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Shared a = new Shared(2);\n    Shared.defaultMode = 2;\n    Shared b = new Shared(4);\n    a.move();\n    b.move();\n    a.move();\n  }\n}\nclass Shared {\n  Turtle t;\n  static int defaultMode = 1;\n  int mode;\n  Shared(int x) {\n    this.t = new Turtle(x, 2);\n    this.mode = Shared.defaultMode;\n  }\n\n  void move() {\n    if (this.mode == 1) {\n      this.t.右を向く();\n    } else {\n      this.t.左を向く();\n    }\n    this.t.前に進む();\n  }\n\n}',
    blanks: [
      {
        id: 'Snapshot',
        before: '    if (this.mode == 1) {',
        after: '    if (@[this.mode]@ == 1) {',
      },
      {
        id: 'Default',
        before: '    Shared.defaultMode = 2;',
        after: '    Shared.defaultMode = @[2]@;',
      },
      {
        id: 'Copy',
        before: '    this.mode = Shared.defaultMode;',
        after: '    this.mode = @[Shared.defaultMode]@;',
      },
    ],
    bugs: [
      {
        id: 'Snapshot',
        before: '    if (this.mode == 1) {',
        after: '    if (Shared.defaultMode == 1) {',
        kind: 'logical',
      },
      {
        id: 'Default',
        before: '    Shared.defaultMode = 2;',
        after: '    Shared.defaultMode = 1;',
        kind: 'logical',
      },
      {
        id: 'Copy',
        before: '    this.mode = Shared.defaultMode;',
        after: '    this.mode = 2;',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII4ResetShared',
    title: '共有カウンタをリセットする',
    courseId: 'tuBeginner2',
    lectureIndex: 3,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Shared a = new Shared(2);\n    Shared b = new Shared(4);\n    a.act();\n    b.act();\n    Shared.reset();\n    b.act();\n  }\n}\nclass Shared {\n  Turtle t;\n  static int count = 0;\n  Shared(int x) {\n    this.t = new Turtle(x, 2);\n    this.t.右を向く();\n  }\n\n  static void reset() {\n    Shared.count = 0;\n  }\n  void act() {\n    Shared.count++;\n    if (Shared.count == 1) {\n      this.t.左を向く();\n    }\n    this.t.前に進む();\n  }\n\n}',
    blanks: [
      {
        id: 'Reset',
        before: '    Shared.count = 0;',
        after: '    Shared.count = @[0]@;',
      },
      {
        id: 'Compare',
        before: '    if (Shared.count == 1) {',
        after: '    if (Shared.count == @[1]@) {',
      },
      {
        id: 'Update',
        before: '    Shared.count++;',
        after: '    Shared.count@[++]@;',
      },
    ],
    bugs: [
      {
        id: 'Reset',
        before: '    Shared.count = 0;',
        after: '    Shared.count = 2;',
        kind: 'logical',
      },
      {
        id: 'Compare',
        before: '    if (Shared.count == 1) {',
        after: '    if (Shared.count == 2) {',
        kind: 'logical',
      },
      {
        id: 'Update',
        before: '    Shared.count++;',
        after: '    Shared.count--;',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII4PairUtility',
    title: '二つの亀を静的メソッドへ渡す',
    courseId: 'tuBeginner2',
    lectureIndex: 3,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Turtle a = new Turtle(2, 2);\n    Turtle b = new Turtle(4, 2, "B");\n    Utility.cross(a, b);\n    a.前に進む();\n    b.後に戻る();\n    Utility.cross(b, a);\n  }\n}\nclass Utility {\n  static void cross(Turtle first, Turtle second) {\n    first.右を向く();\n    second.左を向く();\n    first.前に進む();\n    second.前に進む();\n  }\n}',
    blanks: [
      {
        id: 'Order',
        before: '    Utility.cross(b, a);',
        after: '    Utility.cross(@[b, a]@);',
      },
      {
        id: 'First',
        before: '    first.右を向く();',
        after: '    first.@[右を向く]@();',
      },
      {
        id: 'Second',
        before: '    second.前に進む();',
        after: '    second.@[前に進む]@();',
      },
    ],
    bugs: [
      {
        id: 'Order',
        before: '    Utility.cross(b, a);',
        after: '    Utility.cross(a, b);',
        kind: 'logical',
      },
      {
        id: 'First',
        before: '    first.右を向く();',
        after: '    first.左を向く();',
        kind: 'logical',
      },
      {
        id: 'Second',
        before: '    second.前に進む();',
        after: '    second.後に戻る();',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII4SharedMode',
    title: '一方が変えたモードをもう一方で使う',
    courseId: 'tuBeginner2',
    lectureIndex: 3,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Shared a = new Shared(2);\n    Shared b = new Shared(4);\n    a.move();\n    a.flip();\n    b.move();\n    b.flip();\n    a.move();\n  }\n}\nclass Shared {\n  Turtle t;\n  static boolean right = true;\n  Shared(int x) {\n    this.t = new Turtle(x, 2);\n    this.t.前に進む();\n  }\n\n  void flip() {\n    Shared.right = !Shared.right;\n  }\n  void move() {\n    if (Shared.right) {\n      this.t.右を向く();\n    } else {\n      this.t.左を向く();\n    }\n    this.t.前に進む();\n  }\n\n}',
    blanks: [
      {
        id: 'Flip',
        before: '    Shared.right = !Shared.right;',
        after: '    Shared.right = @[!Shared.right]@;',
      },
      {
        id: 'Read',
        before: '    if (Shared.right) {',
        after: '    if (@[Shared.right]@) {',
      },
      {
        id: 'Start',
        before: '  static boolean right = true;',
        after: '  static boolean right = @[true]@;',
      },
    ],
    bugs: [
      {
        id: 'Flip',
        before: '    Shared.right = !Shared.right;',
        after: '    Shared.right = Shared.right;',
        kind: 'logical',
      },
      {
        id: 'Read',
        before: '    if (Shared.right) {',
        after: '    if (!Shared.right) {',
        kind: 'logical',
      },
      {
        id: 'Start',
        before: '  static boolean right = true;',
        after: '  static boolean right = false;',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII4LocalAndGlobal',
    title: '個別の回数と全体の回数',
    courseId: 'tuBeginner2',
    lectureIndex: 3,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Shared a = new Shared(2);\n    Shared b = new Shared(4);\n    a.act();\n    b.act();\n    a.act();\n  }\n}\nclass Shared {\n  Turtle t;\n  static int total = 0;\n  int own;\n  Shared(int x) {\n    this.t = new Turtle(x, 2);\n    this.own = 0;\n  }\n\n  void act() {\n    this.own++;\n    Shared.total++;\n    if (this.own == Shared.total) {\n      this.t.右を向く();\n    }\n    this.t.前に進む();\n  }\n\n}',
    blanks: [
      {
        id: 'Own',
        before: '    this.own++;',
        after: '    this.own@[++]@;',
      },
      {
        id: 'Total',
        before: '    Shared.total++;',
        after: '    Shared.total@[++]@;',
      },
      {
        id: 'Compare',
        before: '    if (this.own == Shared.total) {',
        after: '    if (this.own @[==]@ Shared.total) {',
      },
    ],
    bugs: [
      {
        id: 'Own',
        before: '    this.own++;',
        after: '    this.own--;',
        kind: 'logical',
      },
      {
        id: 'Total',
        before: '    Shared.total++;',
        after: '    Shared.total--;',
        kind: 'logical',
      },
      {
        id: 'Compare',
        before: '    if (this.own == Shared.total) {',
        after: '    if (this.own != Shared.total) {',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII4OffsetReturn',
    title: '共有の差分を使った静的計算',
    courseId: 'tuBeginner2',
    lectureIndex: 3,
    java: 'public class Main {\n  public static void main(String[] args) {\n    int first = Offset.position(1);\n    Turtle a = new Turtle(first, 2);\n    Offset.shift = 2;\n    int second = Offset.position(1);\n    Turtle b = new Turtle(second, 2, "R");\n    a.前に進む();\n    b.右を向く();\n    b.前に進む();\n    a.左を向く();\n    a.前に進む();\n    b.左を向く();\n    b.前に進む();\n  }\n}\nclass Offset {\n  static int shift = 1;\n  static int position(int origin) {\n    return origin + Offset.shift;\n  }\n}',
    blanks: [
      {
        id: 'Calculation',
        before: '    return origin + Offset.shift;',
        after: '    return origin @[+]@ Offset.shift;',
      },
      {
        id: 'Change',
        before: '    Offset.shift = 2;',
        after: '    Offset.shift = @[2]@;',
      },
      {
        id: 'Saved',
        before: '    Turtle a = new Turtle(first, 2);',
        after: '    Turtle a = new Turtle(@[first]@, 2);',
      },
    ],
    bugs: [
      {
        id: 'Calculation',
        before: '    return origin + Offset.shift;',
        after: '    return origin * Offset.shift;',
        kind: 'logical',
      },
      {
        id: 'Change',
        before: '    Offset.shift = 2;',
        after: '    Offset.shift = 3;',
        kind: 'logical',
      },
      {
        id: 'Saved',
        before: '    Turtle a = new Turtle(first, 2);',
        after: '    Turtle a = new Turtle(first + 1, 2);',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII4IssuedNumber',
    title: '生成順の番号をインスタンスへ保存',
    courseId: 'tuBeginner2',
    lectureIndex: 3,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Shared a = new Shared(2);\n    Shared b = new Shared(4);\n    a.mark();\n    b.mark();\n    a.mark();\n  }\n}\nclass Shared {\n  Turtle t;\n  static int sequence = 0;\n  int number;\n  Shared(int x) {\n    this.t = new Turtle(x, 2);\n    this.number = Shared.sequence;\n    Shared.sequence++;\n  }\n\n  void mark() {\n    if (this.number == 0) {\n      this.t.右を向く();\n    } else {\n      this.t.左を向く();\n    }\n    this.t.前に進む();\n  }\n\n}',
    blanks: [
      {
        id: 'Issue',
        before: '    this.number = Shared.sequence;',
        after: '    this.number = @[Shared.sequence]@;',
      },
      {
        id: 'Increment',
        before: '    Shared.sequence++;',
        after: '    Shared.sequence@[++]@;',
      },
      {
        id: 'Use',
        before: '    if (this.number == 0) {',
        after: '    if (this.number @[==]@ 0) {',
      },
    ],
    bugs: [
      {
        id: 'Issue',
        before: '    this.number = Shared.sequence;',
        after: '    this.number = Shared.sequence + 1;',
        kind: 'logical',
      },
      {
        id: 'Increment',
        before: '    Shared.sequence++;',
        after: '    Shared.sequence += 0;',
        kind: 'logical',
      },
      {
        id: 'Use',
        before: '    if (this.number == 0) {',
        after: '    if (this.number != 0) {',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII4ReadTiming',
    title: '静的な値を保存してから更新',
    courseId: 'tuBeginner2',
    lectureIndex: 3,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Shared a = new Shared(2);\n    Shared b = new Shared(4);\n    int saved = Shared.count;\n    Shared.increment();\n    a.compare(saved);\n    b.compare(Shared.count);\n    Shared.increment();\n    b.compare(saved);\n  }\n}\nclass Shared {\n  Turtle t;\n  static int count = 1;\n  Shared(int x) {\n    this.t = new Turtle(x, 2);\n    this.t.右を向く();\n  }\n\n  static void increment() {\n    Shared.count++;\n  }\n  void compare(int old) {\n    if (old < Shared.count) {\n      this.t.左を向く();\n    }\n    this.t.前に進む();\n  }\n\n}',
    blanks: [
      {
        id: 'Snapshot',
        before: '    int saved = Shared.count;',
        after: '    int saved = @[Shared.count]@;',
      },
      {
        id: 'Increment',
        before: '    Shared.count++;',
        after: '    Shared.count@[++]@;',
      },
      {
        id: 'Compare',
        before: '    if (old < Shared.count) {',
        after: '    if (old @[<]@ Shared.count) {',
      },
    ],
    bugs: [
      {
        id: 'Snapshot',
        before: '    int saved = Shared.count;',
        after: '    int saved = Shared.count + 1;',
        kind: 'logical',
      },
      {
        id: 'Increment',
        before: '    Shared.count++;',
        after: '    Shared.count--;',
        kind: 'logical',
      },
      {
        id: 'Compare',
        before: '    if (old < Shared.count) {',
        after: '    if (old <= Shared.count) {',
        kind: 'logical',
      },
    ],
  },
];
