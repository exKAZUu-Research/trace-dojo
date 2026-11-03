import type { ChallengeBase } from '../types';

export const lecture3: ChallengeBase[] = [
  {
    id: 'challengeII3RejectRequest',
    title: '範囲外の設定を受け付けない',
    courseId: 'tuBeginner2',
    lectureIndex: 2,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Vault v = new Vault(); // caller\n    v.setAmount(2); // caller\n    v.use(); // caller\n    v.setAmount(4); // caller\n    v.use(); // caller\n    v.setAmount(0); // caller\n    v.use(); // caller\n    v.use(); // caller\n  }\n}\nclass Vault {\n  private Turtle t;\n  private int amount;\n  Vault() {\n    this.t = new Turtle(2, 2); // step\n    this.amount = 1; // step\n  }\n\n  void setAmount(int value) {\n    if (value >= 0 && value <= 2) {\n      this.amount = value; // step\n    }\n  }\n  void use() {\n    if (this.amount == 2) {\n      this.t.前に進む(); // step\n    }\n    this.t.右を向く(); // step\n  }\n\n}',
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
        before: '    v.setAmount(2); // caller',
        after: '    v.setAmount(@[2]@); // caller',
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
        before: '    v.setAmount(2); // caller',
        after: '    v.setAmount(0); // caller',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII3SpendRequest',
    title: 'まとめて使える残り回数',
    courseId: 'tuBeginner2',
    lectureIndex: 2,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Vault v = new Vault(); // caller\n    v.spend(2); // caller\n    v.spend(2); // caller\n    v.spend(1); // caller\n    v.spend(1); // caller\n  }\n}\nclass Vault {\n  private Turtle t;\n  private int left;\n  Vault() {\n    this.t = new Turtle(2, 2); // step\n    this.left = 3; // step\n  }\n\n  void spend(int requested) {\n    if (requested <= this.left) {\n      this.left -= requested; // step\n      this.t.前に進む(); // step\n    }\n    this.t.右を向く(); // step\n  }\n\n}',
    blanks: [
      {
        id: 'Check',
        before: '    if (requested <= this.left) {',
        after: '    if (requested @[<=]@ this.left) {',
      },
      {
        id: 'Consume',
        before: '      this.left -= requested; // step',
        after: '      this.left @[-=]@ requested; // step',
      },
      {
        id: 'SecondRequest',
        before: '    v.spend(2); // caller\n    v.spend(1); // caller',
        after: '    v.spend(@[2]@); // caller\n    v.spend(1); // caller',
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
        before: '      this.left -= requested; // step',
        after: '      this.left += requested; // step',
        kind: 'logical',
      },
      {
        id: 'SecondRequest',
        before: '    v.spend(2); // caller\n    v.spend(1); // caller',
        after: '    v.spend(0); // caller\n    v.spend(1); // caller',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII3ToggleMode',
    title: '公開メソッドで方向モードを切り替える',
    courseId: 'tuBeginner2',
    lectureIndex: 2,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Vault v = new Vault(); // caller\n    v.move(); // caller\n    v.toggle(); // caller\n    v.move(); // caller\n    v.move(); // caller\n    v.toggle(); // caller\n    v.move(); // caller\n  }\n}\nclass Vault {\n  private Turtle t;\n  private boolean right;\n  Vault() {\n    this.t = new Turtle(2, 2); // step\n    this.right = true; // step\n  }\n\n  void toggle() {\n    this.right = !this.right; // step\n  }\n  void move() {\n    if (this.right) {\n      this.t.右を向く(); // step\n    } else {\n      this.t.左を向く(); // step\n    }\n    this.t.前に進む(); // step\n  }\n\n}',
    blanks: [
      {
        id: 'Toggle',
        before: '    this.right = !this.right; // step',
        after: '    this.right = @[!this.right]@; // step',
      },
      {
        id: 'Interpret',
        before: '    if (this.right) {',
        after: '    if (@[this.right]@) {',
      },
      {
        id: 'Start',
        before: '    this.right = true; // step',
        after: '    this.right = @[true]@; // step',
      },
    ],
    bugs: [
      {
        id: 'Toggle',
        before: '    this.right = !this.right; // step',
        after: '    this.right = this.right; // step',
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
        before: '    this.right = true; // step',
        after: '    this.right = false; // step',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII3ResetCounter',
    title: '位置を戻さずカウンタだけ戻す',
    courseId: 'tuBeginner2',
    lectureIndex: 2,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Vault v = new Vault(); // caller\n    v.pulse(); // caller\n    v.pulse(); // caller\n    v.reset(); // caller\n    v.pulse(); // caller\n  }\n}\nclass Vault {\n  private Turtle t;\n  private int count;\n  Vault() {\n    this.t = new Turtle(2, 2); // step\n    this.count = 0; // step\n  }\n\n  void reset() {\n    this.count = 0; // step\n  }\n  void pulse() {\n    this.count++; // step\n    if (this.count == 1) {\n      this.t.右を向く(); // step\n    }\n    this.t.前に進む(); // step\n  }\n\n}',
    blanks: [
      {
        id: 'Reset',
        before: '  void reset() {\n    this.count = 0; // step',
        after: '  void reset() {\n    this.count = @[0]@; // step',
      },
      {
        id: 'Threshold',
        before: '    if (this.count == 1) {',
        after: '    if (this.count == @[1]@) {',
      },
      {
        id: 'Advance',
        before: '    this.count++; // step',
        after: '    this.count@[++]@; // step',
      },
    ],
    bugs: [
      {
        id: 'Reset',
        before: '  void reset() {\n    this.count = 0; // step',
        after: '  void reset() {\n    this.count = 2; // step',
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
        before: '    this.count++; // step',
        after: '    this.count--; // step',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII3SavedGetter',
    title: '取得した数と現在の数',
    courseId: 'tuBeginner2',
    lectureIndex: 2,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Vault v = new Vault(); // caller\n    int saved = v.getCount(); // step // caller\n    v.increase(); // caller\n    v.choose(saved); // caller\n    int current = v.getCount(); // step // caller\n    v.choose(current); // caller\n    v.increase(); // caller\n    v.choose(saved); // caller\n  }\n}\nclass Vault {\n  private Turtle t;\n  private int count;\n  Vault() {\n    this.t = new Turtle(2, 2); // step\n    this.count = 1; // step\n  }\n\n  int getCount() {\n    return this.count;\n  }\n  void increase() {\n    this.count++; // step\n    this.t.前に進む(); // step\n  }\n  void choose(int saved) {\n    if (saved < this.count) {\n      this.t.右を向く(); // step\n    } else {\n      this.t.左を向く(); // step\n    }\n    this.t.前に進む(); // step\n  }\n\n}',
    blanks: [
      {
        id: 'Snapshot',
        before: '    v.choose(saved); // caller\n    int current = v.getCount(); // step // caller',
        after: '    v.choose(@[saved]@); // caller\n    int current = v.getCount(); // step // caller',
      },
      {
        id: 'Comparison',
        before: '    if (saved < this.count) {',
        after: '    if (saved @[<]@ this.count) {',
      },
      {
        id: 'Increment',
        before: '    this.count++; // step',
        after: '    this.count@[++]@; // step',
      },
    ],
    bugs: [
      {
        id: 'Snapshot',
        before: '    v.choose(saved); // caller\n    int current = v.getCount(); // step // caller',
        after: '    v.choose(saved + 1); // caller\n    int current = v.getCount(); // step // caller',
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
        before: '    this.count++; // step',
        after: '    this.count--; // step',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII3TransferCredit',
    title: '取り出した値を別の操作へ渡す',
    courseId: 'tuBeginner2',
    lectureIndex: 2,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Vault v = new Vault(); // caller\n    int taken = v.withdraw(); // step // caller\n    v.mark(); // caller\n    v.deposit(taken); // caller\n    v.mark(); // caller\n    v.mark(); // caller\n  }\n}\nclass Vault {\n  private Turtle t;\n  private int credit;\n  Vault() {\n    this.t = new Turtle(2, 2); // step\n    this.credit = 2; // step\n  }\n\n  int withdraw() {\n    int old = this.credit; // step\n    this.credit = 0; // step\n    return old;\n  }\n  void deposit(int value) {\n    this.credit += value; // step\n  }\n  void mark() {\n    if (this.credit > 1) {\n      this.t.前に進む(); // step\n    }\n    this.t.右を向く(); // step\n  }\n\n}',
    blanks: [
      {
        id: 'Empty',
        before: '    this.credit = 0; // step',
        after: '    this.credit = @[0]@; // step',
      },
      {
        id: 'Deposit',
        before: '    this.credit += value; // step',
        after: '    this.credit @[+=]@ value; // step',
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
        before: '    this.credit = 0; // step',
        after: '    this.credit = 2; // step',
        kind: 'logical',
      },
      {
        id: 'Deposit',
        before: '    this.credit += value; // step',
        after: '    this.credit -= value; // step',
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
    java: 'public class Main {\n  public static void main(String[] args) {\n    Vault v = new Vault(); // caller\n    v.resize(2, 1); // caller\n    v.mark(); // caller\n    v.resize(1, 2); // caller\n    v.mark(); // caller\n    v.mark(); // caller\n  }\n}\nclass Vault {\n  private Turtle t;\n  private int width;\n  private int height;\n  Vault() {\n    this.t = new Turtle(2, 2); // step\n    this.width = 1; // step\n    this.height = 1; // step\n  }\n\n  void resize(int x, int y) {\n    this.width = x; // step\n    this.height = y; // step\n  }\n  void mark() {\n    if (this.width > this.height) {\n      this.t.右を向く(); // step\n    }\n    this.t.前に進む(); // step\n  }\n\n}',
    blanks: [
      {
        id: 'SecondField',
        before: '    this.height = y; // step',
        after: '    this.height = @[y]@; // step',
      },
      {
        id: 'Compare',
        before: '    if (this.width > this.height) {',
        after: '    if (this.width @[>]@ this.height) {',
      },
      {
        id: 'FirstResize',
        before: '    v.resize(2, 1); // caller',
        after: '    v.resize(@[2, 1]@); // caller',
      },
    ],
    bugs: [
      {
        id: 'SecondField',
        before: '    this.height = y; // step',
        after: '    this.height = x; // step',
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
        before: '    v.resize(2, 1); // caller',
        after: '    v.resize(1, 2); // caller',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII3ThresholdPulse',
    title: '二回の要求で一度だけ進む',
    courseId: 'tuBeginner2',
    lectureIndex: 2,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Vault v = new Vault(); // caller\n    v.request(); // caller\n    v.request(); // caller\n    v.request(); // caller\n    v.request(); // caller\n  }\n}\nclass Vault {\n  private Turtle t;\n  private int pending;\n  Vault() {\n    this.t = new Turtle(2, 2); // step\n    this.pending = 0; // step\n  }\n\n  void request() {\n    this.pending++; // step\n    if (this.pending == 2) {\n      this.t.前に進む(); // step\n      this.t.右を向く(); // step\n      this.pending = 0; // step\n    }\n  }\n\n}',
    blanks: [
      {
        id: 'Threshold',
        before: '    if (this.pending == 2) {',
        after: '    if (this.pending == @[2]@) {',
      },
      {
        id: 'Reset',
        before: '      this.t.右を向く(); // step\n      this.pending = 0; // step',
        after: '      this.t.右を向く(); // step\n      this.pending = @[0]@; // step',
      },
      {
        id: 'Accumulate',
        before: '    this.pending++; // step',
        after: '    this.pending@[++]@; // step',
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
        before: '      this.t.右を向く(); // step\n      this.pending = 0; // step',
        after: '      this.t.右を向く(); // step\n      this.pending = 1; // step',
        kind: 'logical',
      },
      {
        id: 'Accumulate',
        before: '    this.pending++; // step',
        after: '    this.pending--; // step',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII3BoundedChanges',
    title: '上限と下限のある増減',
    courseId: 'tuBeginner2',
    lectureIndex: 2,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Vault v = new Vault(); // caller\n    v.raise(); // caller\n    v.raise(); // caller\n    v.mark(); // caller\n    v.lower(); // caller\n    v.mark(); // caller\n    v.raise(); // caller\n    v.mark(); // caller\n  }\n}\nclass Vault {\n  private Turtle t;\n  private int level;\n  Vault() {\n    this.t = new Turtle(2, 2); // step\n    this.level = 1; // step\n  }\n\n  void raise() {\n    if (this.level < 2) {\n      this.level++; // step\n    }\n  }\n  void lower() {\n    if (this.level > 0) {\n      this.level--; // step\n    }\n  }\n  void mark() {\n    if (this.level == 2) {\n      this.t.右を向く(); // step\n    }\n    this.t.前に進む(); // step\n  }\n\n}',
    blanks: [
      {
        id: 'Upper',
        before: '    if (this.level < 2) {',
        after: '    if (this.level @[<]@ 2) {',
      },
      {
        id: 'Lower',
        before: '      this.level--; // step',
        after: '      this.level@[--]@; // step',
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
        before: '      this.level--; // step',
        after: '      this.level++; // step',
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
    java: 'public class Main {\n  public static void main(String[] args) {\n    Vault v = new Vault(); // caller\n    int first = v.take(); // step // caller\n    v.mark(first); // caller\n    int second = v.take(); // step // caller\n    v.mark(second); // caller\n    v.mark(second + 1); // caller\n  }\n}\nclass Vault {\n  private Turtle t;\n  private int next;\n  Vault() {\n    this.t = new Turtle(2, 2); // step\n    this.next = 1; // step\n  }\n\n  int take() {\n    int old = this.next; // step\n    this.next++; // step\n    return old;\n  }\n  void mark(int value) {\n    if (value == this.next) {\n      this.t.左を向く(); // step\n    } else {\n      this.t.右を向く(); // step\n    }\n    this.t.前に進む(); // step\n  }\n\n}',
    blanks: [
      {
        id: 'Return',
        before: '    return old;',
        after: '    return @[old]@;',
      },
      {
        id: 'Update',
        before: '    this.next++; // step',
        after: '    this.next@[++]@; // step',
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
        before: '    this.next++; // step',
        after: '    this.next--; // step',
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
