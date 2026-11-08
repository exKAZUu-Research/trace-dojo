import type { CorrectProblem } from '../types';

export const lecture3: CorrectProblem[] = [
  {
    id: 'challengeII3RejectRequest',
    title: '範囲外の設定を受け付けない',
    courseId: 'tuBeginner2',
    lectureIndex: 2,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Vault v = new Vault();\n    v.setAmount(2);\n    v.use();\n    v.setAmount(4);\n    v.use();\n    v.setAmount(0);\n    v.use();\n    v.use();\n  }\n}\nclass Vault {\n  private Turtle t;\n  private int amount;\n  Vault() {\n    this.t = new Turtle(2, 2);\n    this.amount = 1;\n  }\n\n  void setAmount(int value) {\n    if (value >= 0 && value <= 2) {\n      this.amount = value;\n    }\n  }\n  void use() {\n    if (this.amount == 2) {\n      this.t.前に進む();\n    }\n    this.t.右を向く();\n  }\n\n}',
  },
  {
    id: 'challengeII3SpendRequest',
    title: 'まとめて使える残り回数',
    courseId: 'tuBeginner2',
    lectureIndex: 2,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Vault v = new Vault();\n    v.spend(2);\n    v.spend(2);\n    v.spend(1);\n    v.spend(1);\n  }\n}\nclass Vault {\n  private Turtle t;\n  private int left;\n  Vault() {\n    this.t = new Turtle(2, 2);\n    this.left = 3;\n  }\n\n  void spend(int requested) {\n    if (requested <= this.left) {\n      this.left -= requested;\n      this.t.前に進む();\n    }\n    this.t.右を向く();\n  }\n\n}',
  },
  {
    id: 'challengeII3ToggleMode',
    title: '公開メソッドで方向モードを切り替える',
    courseId: 'tuBeginner2',
    lectureIndex: 2,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Vault v = new Vault();\n    v.move();\n    v.toggle();\n    v.move();\n    v.move();\n    v.toggle();\n    v.move();\n  }\n}\nclass Vault {\n  private Turtle t;\n  private boolean right;\n  Vault() {\n    this.t = new Turtle(2, 2);\n    this.right = true;\n  }\n\n  void toggle() {\n    this.right = !this.right;\n  }\n  void move() {\n    if (this.right) {\n      this.t.右を向く();\n    } else {\n      this.t.左を向く();\n    }\n    this.t.前に進む();\n  }\n\n}',
  },
  {
    id: 'challengeII3ResetCounter',
    title: '位置を戻さずカウンタだけ戻す',
    courseId: 'tuBeginner2',
    lectureIndex: 2,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Vault v = new Vault();\n    v.pulse();\n    v.pulse();\n    v.reset();\n    v.pulse();\n  }\n}\nclass Vault {\n  private Turtle t;\n  private int count;\n  Vault() {\n    this.t = new Turtle(2, 2);\n    this.count = 0;\n  }\n\n  void reset() {\n    this.count = 0;\n  }\n  void pulse() {\n    this.count++;\n    if (this.count == 1) {\n      this.t.右を向く();\n    }\n    this.t.前に進む();\n  }\n\n}',
  },
  {
    id: 'challengeII3SavedGetter',
    title: '取得した数と現在の数',
    courseId: 'tuBeginner2',
    lectureIndex: 2,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Vault v = new Vault();\n    int saved = v.getCount();\n    v.increase();\n    v.choose(saved);\n    int current = v.getCount();\n    v.choose(current);\n    v.increase();\n    v.choose(saved);\n  }\n}\nclass Vault {\n  private Turtle t;\n  private int count;\n  Vault() {\n    this.t = new Turtle(2, 2);\n    this.count = 1;\n  }\n\n  int getCount() {\n    return this.count;\n  }\n  void increase() {\n    this.count++;\n    this.t.前に進む();\n  }\n  void choose(int saved) {\n    if (saved < this.count) {\n      this.t.右を向く();\n    } else {\n      this.t.左を向く();\n    }\n    this.t.前に進む();\n  }\n\n}',
  },
  {
    id: 'challengeII3TransferCredit',
    title: '取り出した値を別の操作へ渡す',
    courseId: 'tuBeginner2',
    lectureIndex: 2,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Vault v = new Vault();\n    int taken = v.withdraw();\n    v.mark();\n    v.deposit(taken);\n    v.mark();\n    v.mark();\n  }\n}\nclass Vault {\n  private Turtle t;\n  private int credit;\n  Vault() {\n    this.t = new Turtle(2, 2);\n    this.credit = 2;\n  }\n\n  int withdraw() {\n    int old = this.credit;\n    this.credit = 0;\n    return old;\n  }\n  void deposit(int value) {\n    this.credit += value;\n  }\n  void mark() {\n    if (this.credit > 1) {\n      this.t.前に進む();\n    }\n    this.t.右を向く();\n  }\n\n}',
  },
  {
    id: 'challengeII3PairedUpdate',
    title: '二つの状態を一緒に更新',
    courseId: 'tuBeginner2',
    lectureIndex: 2,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Vault v = new Vault();\n    v.resize(2, 1);\n    v.mark();\n    v.resize(1, 2);\n    v.mark();\n    v.mark();\n  }\n}\nclass Vault {\n  private Turtle t;\n  private int width;\n  private int height;\n  Vault() {\n    this.t = new Turtle(2, 2);\n    this.width = 1;\n    this.height = 1;\n  }\n\n  void resize(int x, int y) {\n    this.width = x;\n    this.height = y;\n  }\n  void mark() {\n    if (this.width > this.height) {\n      this.t.右を向く();\n    }\n    this.t.前に進む();\n  }\n\n}',
  },
  {
    id: 'challengeII3ThresholdPulse',
    title: '二回の要求で一度だけ進む',
    courseId: 'tuBeginner2',
    lectureIndex: 2,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Vault v = new Vault();\n    v.request();\n    v.request();\n    v.request();\n    v.request();\n  }\n}\nclass Vault {\n  private Turtle t;\n  private int pending;\n  Vault() {\n    this.t = new Turtle(2, 2);\n    this.pending = 0;\n  }\n\n  void request() {\n    this.pending++;\n    if (this.pending == 2) {\n      this.t.前に進む();\n      this.t.右を向く();\n      this.pending = 0;\n    }\n  }\n\n}',
  },
  {
    id: 'challengeII3BoundedChanges',
    title: '上限と下限のある増減',
    courseId: 'tuBeginner2',
    lectureIndex: 2,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Vault v = new Vault();\n    v.raise();\n    v.raise();\n    v.mark();\n    v.lower();\n    v.mark();\n    v.raise();\n    v.mark();\n  }\n}\nclass Vault {\n  private Turtle t;\n  private int level;\n  Vault() {\n    this.t = new Turtle(2, 2);\n    this.level = 1;\n  }\n\n  void raise() {\n    if (this.level < 2) {\n      this.level++;\n    }\n  }\n  void lower() {\n    if (this.level > 0) {\n      this.level--;\n    }\n  }\n  void mark() {\n    if (this.level == 2) {\n      this.t.右を向く();\n    }\n    this.t.前に進む();\n  }\n\n}',
  },
  {
    id: 'challengeII3ConsumeOldValue',
    title: '古い値を返してから更新する',
    courseId: 'tuBeginner2',
    lectureIndex: 2,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Vault v = new Vault();\n    int first = v.take();\n    v.mark(first);\n    int second = v.take();\n    v.mark(second);\n    v.mark(second + 1);\n  }\n}\nclass Vault {\n  private Turtle t;\n  private int next;\n  Vault() {\n    this.t = new Turtle(2, 2);\n    this.next = 1;\n  }\n\n  int take() {\n    int old = this.next;\n    this.next++;\n    return old;\n  }\n  void mark(int value) {\n    if (value == this.next) {\n      this.t.左を向く();\n    } else {\n      this.t.右を向く();\n    }\n    this.t.前に進む();\n  }\n\n}',
  },
];
