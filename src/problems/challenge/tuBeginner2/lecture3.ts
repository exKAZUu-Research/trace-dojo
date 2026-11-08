import type { ChallengeBase } from '../types';

export const lecture3: ChallengeBase[] = [
  {
    id: 'challengeII3RejectRequest',
    title: '範囲外の設定を受け付けない',
    courseId: 'tuBeginner2',
    lectureIndex: 2,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Vault v = new Vault();\n    v.setAmount(2);\n    v.use();\n    v.setAmount(4);\n    v.use();\n    v.setAmount(0);\n    v.use();\n    v.use();\n  }\n}\nclass Vault {\n  private Turtle t;\n  private int amount;\n  Vault() {\n    this.t = new Turtle(2, 2);\n    this.amount = 1;\n  }\n\n  void setAmount(int value) {\n    if (value >= 0 && value <= 2) {\n      this.amount = value;\n    }\n  }\n  void use() {\n    if (this.amount == 2) {\n      this.t.前に進む();\n    }\n    this.t.右を向く();\n  }\n\n}',
    blanks: [
      {
        id: 'Limit',
        before: '    if (value >= 0 && value <= 2) {',
        after: '    if (value >= 0 && value <= @[2]@) {',
      },
      {
        id: 'Retained',
        before: '    if (this.amount == 2) {',
        after: '    if (this.amount @[==]@ 2) {',
      },
      {
        id: 'Accepted',
        before: '    v.setAmount(2);',
        after: '    v.setAmount(@[2]@);',
      },
    ],
    bugs: [
      {
        id: 'Limit',
        before: '    if (value >= 0 && value <= 2) {',
        after: '    if (value >= 0 && value <= 4) {',
        kind: 'logical',
      },
      {
        id: 'Retained',
        before: '    if (this.amount == 2) {',
        after: '    if (this.amount != 2) {',
        kind: 'logical',
      },
      {
        id: 'Accepted',
        before: '    v.setAmount(2);',
        after: '    v.setAmount(0);',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII3SpendRequest',
    title: 'まとめて使える残り回数',
    courseId: 'tuBeginner2',
    lectureIndex: 2,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Vault v = new Vault();\n    v.spend(2);\n    v.spend(2);\n    v.spend(1);\n    v.spend(1);\n  }\n}\nclass Vault {\n  private Turtle t;\n  private int left;\n  Vault() {\n    this.t = new Turtle(2, 2);\n    this.left = 3;\n  }\n\n  void spend(int requested) {\n    if (requested <= this.left) {\n      this.left -= requested;\n      this.t.前に進む();\n    }\n    this.t.右を向く();\n  }\n\n}',
    blanks: [
      {
        id: 'Check',
        before: '    if (requested <= this.left) {',
        after: '    if (requested @[<=]@ this.left) {',
      },
      {
        id: 'Consume',
        before: '      this.left -= requested;',
        after: '      this.left @[-=]@ requested;',
      },
      {
        id: 'SecondRequest',
        before: '    v.spend(2);\n    v.spend(1);',
        after: '    v.spend(@[2]@);\n    v.spend(1);',
      },
    ],
    bugs: [
      {
        id: 'Check',
        before: '    if (requested <= this.left) {',
        after: '    if (requested < this.left) {',
        kind: 'logical',
      },
      {
        id: 'Consume',
        before: '      this.left -= requested;',
        after: '      this.left += requested;',
        kind: 'logical',
      },
      {
        id: 'SecondRequest',
        before: '    v.spend(2);\n    v.spend(1);',
        after: '    v.spend(0);\n    v.spend(1);',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII3ToggleMode',
    title: '公開メソッドで方向モードを切り替える',
    courseId: 'tuBeginner2',
    lectureIndex: 2,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Vault v = new Vault();\n    v.move();\n    v.toggle();\n    v.move();\n    v.move();\n    v.toggle();\n    v.move();\n  }\n}\nclass Vault {\n  private Turtle t;\n  private boolean right;\n  Vault() {\n    this.t = new Turtle(2, 2);\n    this.right = true;\n  }\n\n  void toggle() {\n    this.right = !this.right;\n  }\n  void move() {\n    if (this.right) {\n      this.t.右を向く();\n    } else {\n      this.t.左を向く();\n    }\n    this.t.前に進む();\n  }\n\n}',
    blanks: [
      {
        id: 'Toggle',
        before: '    this.right = !this.right;',
        after: '    this.right = @[!this.right]@;',
      },
      {
        id: 'Interpret',
        before: '    if (this.right) {',
        after: '    if (@[this.right]@) {',
      },
      {
        id: 'Start',
        before: '    this.right = true;',
        after: '    this.right = @[true]@;',
      },
    ],
    bugs: [
      {
        id: 'Toggle',
        before: '    this.right = !this.right;',
        after: '    this.right = this.right;',
        kind: 'logical',
      },
      {
        id: 'Interpret',
        before: '    if (this.right) {',
        after: '    if (!this.right) {',
        kind: 'logical',
      },
      {
        id: 'Start',
        before: '    this.right = true;',
        after: '    this.right = false;',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII3ResetCounter',
    title: '位置を戻さずカウンタだけ戻す',
    courseId: 'tuBeginner2',
    lectureIndex: 2,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Vault v = new Vault();\n    v.pulse();\n    v.pulse();\n    v.reset();\n    v.pulse();\n  }\n}\nclass Vault {\n  private Turtle t;\n  private int count;\n  Vault() {\n    this.t = new Turtle(2, 2);\n    this.count = 0;\n  }\n\n  void reset() {\n    this.count = 0;\n  }\n  void pulse() {\n    this.count++;\n    if (this.count == 1) {\n      this.t.右を向く();\n    }\n    this.t.前に進む();\n  }\n\n}',
    blanks: [
      {
        id: 'Reset',
        before: '  void reset() {\n    this.count = 0;',
        after: '  void reset() {\n    this.count = @[0]@;',
      },
      {
        id: 'Threshold',
        before: '    if (this.count == 1) {',
        after: '    if (this.count == @[1]@) {',
      },
      {
        id: 'Advance',
        before: '    this.count++;',
        after: '    this.count@[++]@;',
      },
    ],
    bugs: [
      {
        id: 'Reset',
        before: '  void reset() {\n    this.count = 0;',
        after: '  void reset() {\n    this.count = 2;',
        kind: 'logical',
      },
      {
        id: 'Threshold',
        before: '    if (this.count == 1) {',
        after: '    if (this.count == 2) {',
        kind: 'logical',
      },
      {
        id: 'Advance',
        before: '    this.count++;',
        after: '    this.count--;',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII3SavedGetter',
    title: '取得した数と現在の数',
    courseId: 'tuBeginner2',
    lectureIndex: 2,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Vault v = new Vault();\n    int saved = v.getCount();\n    v.increase();\n    v.choose(saved);\n    int current = v.getCount();\n    v.choose(current);\n    v.increase();\n    v.choose(saved);\n  }\n}\nclass Vault {\n  private Turtle t;\n  private int count;\n  Vault() {\n    this.t = new Turtle(2, 2);\n    this.count = 1;\n  }\n\n  int getCount() {\n    return this.count;\n  }\n  void increase() {\n    this.count++;\n    this.t.前に進む();\n  }\n  void choose(int saved) {\n    if (saved < this.count) {\n      this.t.右を向く();\n    } else {\n      this.t.左を向く();\n    }\n    this.t.前に進む();\n  }\n\n}',
    blanks: [
      {
        id: 'Snapshot',
        before: '    v.choose(saved);\n    int current = v.getCount();',
        after: '    v.choose(@[saved]@);\n    int current = v.getCount();',
      },
      {
        id: 'Comparison',
        before: '    if (saved < this.count) {',
        after: '    if (saved @[<]@ this.count) {',
      },
      {
        id: 'Increment',
        before: '    this.count++;',
        after: '    this.count@[++]@;',
      },
    ],
    bugs: [
      {
        id: 'Snapshot',
        before: '    v.choose(saved);\n    int current = v.getCount();',
        after: '    v.choose(saved + 1);\n    int current = v.getCount();',
        kind: 'logical',
      },
      {
        id: 'Comparison',
        before: '    if (saved < this.count) {',
        after: '    if (saved <= this.count) {',
        kind: 'logical',
      },
      {
        id: 'Increment',
        before: '    this.count++;',
        after: '    this.count--;',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII3TransferCredit',
    title: '取り出した値を別の操作へ渡す',
    courseId: 'tuBeginner2',
    lectureIndex: 2,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Vault v = new Vault();\n    int taken = v.withdraw();\n    v.mark();\n    v.deposit(taken);\n    v.mark();\n    v.mark();\n  }\n}\nclass Vault {\n  private Turtle t;\n  private int credit;\n  Vault() {\n    this.t = new Turtle(2, 2);\n    this.credit = 2;\n  }\n\n  int withdraw() {\n    int old = this.credit;\n    this.credit = 0;\n    return old;\n  }\n  void deposit(int value) {\n    this.credit += value;\n  }\n  void mark() {\n    if (this.credit > 1) {\n      this.t.前に進む();\n    }\n    this.t.右を向く();\n  }\n\n}',
    blanks: [
      {
        id: 'Empty',
        before: '    this.credit = 0;',
        after: '    this.credit = @[0]@;',
      },
      {
        id: 'Deposit',
        before: '    this.credit += value;',
        after: '    this.credit @[+=]@ value;',
      },
      {
        id: 'Threshold',
        before: '    if (this.credit > 1) {',
        after: '    if (this.credit > @[1]@) {',
      },
    ],
    bugs: [
      {
        id: 'Empty',
        before: '    this.credit = 0;',
        after: '    this.credit = 2;',
        kind: 'logical',
      },
      {
        id: 'Deposit',
        before: '    this.credit += value;',
        after: '    this.credit -= value;',
        kind: 'logical',
      },
      {
        id: 'Threshold',
        before: '    if (this.credit > 1) {',
        after: '    if (this.credit > 2) {',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII3PairedUpdate',
    title: '二つの状態を一緒に更新',
    courseId: 'tuBeginner2',
    lectureIndex: 2,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Vault v = new Vault();\n    v.resize(2, 1);\n    v.mark();\n    v.resize(1, 2);\n    v.mark();\n    v.mark();\n  }\n}\nclass Vault {\n  private Turtle t;\n  private int width;\n  private int height;\n  Vault() {\n    this.t = new Turtle(2, 2);\n    this.width = 1;\n    this.height = 1;\n  }\n\n  void resize(int x, int y) {\n    this.width = x;\n    this.height = y;\n  }\n  void mark() {\n    if (this.width > this.height) {\n      this.t.右を向く();\n    }\n    this.t.前に進む();\n  }\n\n}',
    blanks: [
      {
        id: 'SecondField',
        before: '    this.height = y;',
        after: '    this.height = @[y]@;',
      },
      {
        id: 'Compare',
        before: '    if (this.width > this.height) {',
        after: '    if (this.width @[>]@ this.height) {',
      },
      {
        id: 'FirstResize',
        before: '    v.resize(2, 1);',
        after: '    v.resize(@[2, 1]@);',
      },
    ],
    bugs: [
      {
        id: 'SecondField',
        before: '    this.height = y;',
        after: '    this.height = x;',
        kind: 'logical',
      },
      {
        id: 'Compare',
        before: '    if (this.width > this.height) {',
        after: '    if (this.width < this.height) {',
        kind: 'logical',
      },
      {
        id: 'FirstResize',
        before: '    v.resize(2, 1);',
        after: '    v.resize(1, 2);',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII3ThresholdPulse',
    title: '二回の要求で一度だけ進む',
    courseId: 'tuBeginner2',
    lectureIndex: 2,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Vault v = new Vault();\n    v.request();\n    v.request();\n    v.request();\n    v.request();\n  }\n}\nclass Vault {\n  private Turtle t;\n  private int pending;\n  Vault() {\n    this.t = new Turtle(2, 2);\n    this.pending = 0;\n  }\n\n  void request() {\n    this.pending++;\n    if (this.pending == 2) {\n      this.t.前に進む();\n      this.t.右を向く();\n      this.pending = 0;\n    }\n  }\n\n}',
    blanks: [
      {
        id: 'Threshold',
        before: '    if (this.pending == 2) {',
        after: '    if (this.pending == @[2]@) {',
      },
      {
        id: 'Reset',
        before: '      this.t.右を向く();\n      this.pending = 0;',
        after: '      this.t.右を向く();\n      this.pending = @[0]@;',
      },
      {
        id: 'Accumulate',
        before: '    this.pending++;',
        after: '    this.pending@[++]@;',
      },
    ],
    bugs: [
      {
        id: 'Threshold',
        before: '    if (this.pending == 2) {',
        after: '    if (this.pending == 1) {',
        kind: 'logical',
      },
      {
        id: 'Reset',
        before: '      this.t.右を向く();\n      this.pending = 0;',
        after: '      this.t.右を向く();\n      this.pending = 1;',
        kind: 'logical',
      },
      {
        id: 'Accumulate',
        before: '    this.pending++;',
        after: '    this.pending--;',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII3BoundedChanges',
    title: '上限と下限のある増減',
    courseId: 'tuBeginner2',
    lectureIndex: 2,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Vault v = new Vault();\n    v.raise();\n    v.raise();\n    v.mark();\n    v.lower();\n    v.mark();\n    v.raise();\n    v.mark();\n  }\n}\nclass Vault {\n  private Turtle t;\n  private int level;\n  Vault() {\n    this.t = new Turtle(2, 2);\n    this.level = 1;\n  }\n\n  void raise() {\n    if (this.level < 2) {\n      this.level++;\n    }\n  }\n  void lower() {\n    if (this.level > 0) {\n      this.level--;\n    }\n  }\n  void mark() {\n    if (this.level == 2) {\n      this.t.右を向く();\n    }\n    this.t.前に進む();\n  }\n\n}',
    blanks: [
      {
        id: 'Upper',
        before: '    if (this.level < 2) {',
        after: '    if (this.level @[<]@ 2) {',
      },
      {
        id: 'Lower',
        before: '      this.level--;',
        after: '      this.level@[--]@;',
      },
      {
        id: 'Observe',
        before: '    if (this.level == 2) {',
        after: '    if (this.level == @[2]@) {',
      },
    ],
    bugs: [
      {
        id: 'Upper',
        before: '    if (this.level < 2) {',
        after: '    if (this.level <= 2) {',
        kind: 'logical',
      },
      {
        id: 'Lower',
        before: '      this.level--;',
        after: '      this.level++;',
        kind: 'logical',
      },
      {
        id: 'Observe',
        before: '    if (this.level == 2) {',
        after: '    if (this.level == 1) {',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII3ConsumeOldValue',
    title: '古い値を返してから更新する',
    courseId: 'tuBeginner2',
    lectureIndex: 2,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Vault v = new Vault();\n    int first = v.take();\n    v.mark(first);\n    int second = v.take();\n    v.mark(second);\n    v.mark(second + 1);\n  }\n}\nclass Vault {\n  private Turtle t;\n  private int next;\n  Vault() {\n    this.t = new Turtle(2, 2);\n    this.next = 1;\n  }\n\n  int take() {\n    int old = this.next;\n    this.next++;\n    return old;\n  }\n  void mark(int value) {\n    if (value == this.next) {\n      this.t.左を向く();\n    } else {\n      this.t.右を向く();\n    }\n    this.t.前に進む();\n  }\n\n}',
    blanks: [
      {
        id: 'Return',
        before: '    return old;',
        after: '    return @[old]@;',
      },
      {
        id: 'Update',
        before: '    this.next++;',
        after: '    this.next@[++]@;',
      },
      {
        id: 'Compare',
        before: '    if (value == this.next) {',
        after: '    if (value @[==]@ this.next) {',
      },
    ],
    bugs: [
      {
        id: 'Return',
        before: '    return old;',
        after: '    return this.next;',
        kind: 'logical',
      },
      {
        id: 'Update',
        before: '    this.next++;',
        after: '    this.next--;',
        kind: 'logical',
      },
      {
        id: 'Compare',
        before: '    if (value == this.next) {',
        after: '    if (value != this.next) {',
        kind: 'logical',
      },
    ],
  },
];
