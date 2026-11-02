import type { ChallengeBase } from '../types';

export const lecture3: ChallengeBase[] = [
  {
    id: 'challengeII3RejectRequest',
    title: '範囲外の設定を受け付けない',
    courseId: 'tuBeginner2',
    lectureIndex: 2,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Vault v = new Vault(); // caller\n    v.setAmount(2); // caller\n    v.use(); // caller\n    v.setAmount(4); // caller\n    v.use(); // caller\n    v.setAmount(0); // caller\n    v.use(); // caller\n    v.use(); // caller\n  }\n}\nclass Vault {\n  private Turtle t;\n  private int amount;\n  Vault() {\n    this.t = new Turtle(2, 2); // step\n    this.amount = 1; // step\n  }\n\n  void setAmount(int value) {\n    if (value >= 0 && value <= 2) {\n      this.amount = value; // step\n    }\n  }\n  void use() {\n    if (this.amount == 2) {\n      this.t.前に進む(); // step\n    }\n    this.t.右を向く(); // step\n  }\n\n}',
    instrumented:
      "function main() {\nlet v = call(Vault)(); registerDisplayRef('v', () => v); \ncall(v.setAmount.bind(v), 'value')(2); \ncall(v.use.bind(v))(); \ncall(v.setAmount.bind(v), 'value')(4); \ncall(v.use.bind(v))(); \ncall(v.setAmount.bind(v), 'value')(0); \ncall(v.use.bind(v))(); \ncall(v.use.bind(v))(); \n}\nclass Vault {\nt = undefined;\namount = 0;\nconstructor() {\nthis.t = new Turtle(2, 2); // step\nthis.amount = 1; // step\n}\n\nsetAmount(value) {\nif (value >= 0 && value <= 2) {\nthis.amount = value; // step\n}\n}\nuse() {\nif (this.amount == 2) {\nthis.t.前に進む(); // step\n}\nthis.t.右を向く(); // step\n}\n\n}\nmain();",
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
    instrumented:
      "function main() {\nlet v = call(Vault)(); registerDisplayRef('v', () => v); \ncall(v.spend.bind(v), 'requested')(2); \ncall(v.spend.bind(v), 'requested')(2); \ncall(v.spend.bind(v), 'requested')(1); \ncall(v.spend.bind(v), 'requested')(1); \n}\nclass Vault {\nt = undefined;\nleft = 0;\nconstructor() {\nthis.t = new Turtle(2, 2); // step\nthis.left = 3; // step\n}\n\nspend(requested) {\nif (requested <= this.left) {\nthis.left -= requested; // step\nthis.t.前に進む(); // step\n}\nthis.t.右を向く(); // step\n}\n\n}\nmain();",
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
    instrumented:
      "function main() {\nlet v = call(Vault)(); registerDisplayRef('v', () => v); \ncall(v.move.bind(v))(); \ncall(v.toggle.bind(v))(); \ncall(v.move.bind(v))(); \ncall(v.move.bind(v))(); \ncall(v.toggle.bind(v))(); \ncall(v.move.bind(v))(); \n}\nclass Vault {\nt = undefined;\nright = false;\nconstructor() {\nthis.t = new Turtle(2, 2); // step\nthis.right = true; // step\n}\n\ntoggle() {\nthis.right = !this.right; // step\n}\nmove() {\nif (this.right) {\nthis.t.右を向く(); // step\n} else {\nthis.t.左を向く(); // step\n}\nthis.t.前に進む(); // step\n}\n\n}\nmain();",
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
    instrumented:
      "function main() {\nlet v = call(Vault)(); registerDisplayRef('v', () => v); \ncall(v.pulse.bind(v))(); \ncall(v.pulse.bind(v))(); \ncall(v.reset.bind(v))(); \ncall(v.pulse.bind(v))(); \n}\nclass Vault {\nt = undefined;\ncount = 0;\nconstructor() {\nthis.t = new Turtle(2, 2); // step\nthis.count = 0; // step\n}\n\nreset() {\nthis.count = 0; // step\n}\npulse() {\nthis.count++; // step\nif (this.count == 1) {\nthis.t.右を向く(); // step\n}\nthis.t.前に進む(); // step\n}\n\n}\nmain();",
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
    instrumented:
      "function main() {\nlet v = call(Vault)(); registerDisplayRef('v', () => v); \nlet saved = call(v.getCount.bind(v))(); s.vars['saved'] = saved; // step \ncall(v.increase.bind(v))(); \ncall(v.choose.bind(v), 'saved')(saved); \nlet current = call(v.getCount.bind(v))(); s.vars['current'] = current; // step \ncall(v.choose.bind(v), 'saved')(current); \ncall(v.increase.bind(v))(); \ncall(v.choose.bind(v), 'saved')(saved); \n}\nclass Vault {\nt = undefined;\ncount = 0;\nconstructor() {\nthis.t = new Turtle(2, 2); // step\nthis.count = 1; // step\n}\n\ngetCount() {\nreturn this.count;\n}\nincrease() {\nthis.count++; // step\nthis.t.前に進む(); // step\n}\nchoose(saved) {\nif (saved < this.count) {\nthis.t.右を向く(); // step\n} else {\nthis.t.左を向く(); // step\n}\nthis.t.前に進む(); // step\n}\n\n}\nmain();",
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
    instrumented:
      "function main() {\nlet v = call(Vault)(); registerDisplayRef('v', () => v); \nlet taken = call(v.withdraw.bind(v))(); s.vars['taken'] = taken; // step \ncall(v.mark.bind(v))(); \ncall(v.deposit.bind(v), 'value')(taken); \ncall(v.mark.bind(v))(); \ncall(v.mark.bind(v))(); \n}\nclass Vault {\nt = undefined;\ncredit = 0;\nconstructor() {\nthis.t = new Turtle(2, 2); // step\nthis.credit = 2; // step\n}\n\nwithdraw() {\nlet old = this.credit; s.vars['old'] = old; // step\nthis.credit = 0; // step\nreturn old;\n}\ndeposit(value) {\nthis.credit += value; // step\n}\nmark() {\nif (this.credit > 1) {\nthis.t.前に進む(); // step\n}\nthis.t.右を向く(); // step\n}\n\n}\nmain();",
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
    instrumented:
      "function main() {\nlet v = call(Vault)(); registerDisplayRef('v', () => v); \ncall(v.resize.bind(v), 'x', 'y')(2, 1); \ncall(v.mark.bind(v))(); \ncall(v.resize.bind(v), 'x', 'y')(1, 2); \ncall(v.mark.bind(v))(); \ncall(v.mark.bind(v))(); \n}\nclass Vault {\nt = undefined;\nwidth = 0;\nheight = 0;\nconstructor() {\nthis.t = new Turtle(2, 2); // step\nthis.width = 1; // step\nthis.height = 1; // step\n}\n\nresize(x, y) {\nthis.width = x; // step\nthis.height = y; // step\n}\nmark() {\nif (this.width > this.height) {\nthis.t.右を向く(); // step\n}\nthis.t.前に進む(); // step\n}\n\n}\nmain();",
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
    instrumented:
      "function main() {\nlet v = call(Vault)(); registerDisplayRef('v', () => v); \ncall(v.request.bind(v))(); \ncall(v.request.bind(v))(); \ncall(v.request.bind(v))(); \ncall(v.request.bind(v))(); \n}\nclass Vault {\nt = undefined;\npending = 0;\nconstructor() {\nthis.t = new Turtle(2, 2); // step\nthis.pending = 0; // step\n}\n\nrequest() {\nthis.pending++; // step\nif (this.pending == 2) {\nthis.t.前に進む(); // step\nthis.t.右を向く(); // step\nthis.pending = 0; // step\n}\n}\n\n}\nmain();",
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
    instrumented:
      "function main() {\nlet v = call(Vault)(); registerDisplayRef('v', () => v); \ncall(v.raise.bind(v))(); \ncall(v.raise.bind(v))(); \ncall(v.mark.bind(v))(); \ncall(v.lower.bind(v))(); \ncall(v.mark.bind(v))(); \ncall(v.raise.bind(v))(); \ncall(v.mark.bind(v))(); \n}\nclass Vault {\nt = undefined;\nlevel = 0;\nconstructor() {\nthis.t = new Turtle(2, 2); // step\nthis.level = 1; // step\n}\n\nraise() {\nif (this.level < 2) {\nthis.level++; // step\n}\n}\nlower() {\nif (this.level > 0) {\nthis.level--; // step\n}\n}\nmark() {\nif (this.level == 2) {\nthis.t.右を向く(); // step\n}\nthis.t.前に進む(); // step\n}\n\n}\nmain();",
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
    instrumented:
      "function main() {\nlet v = call(Vault)(); registerDisplayRef('v', () => v); \nlet first = call(v.take.bind(v))(); s.vars['first'] = first; // step \ncall(v.mark.bind(v), 'value')(first); \nlet second = call(v.take.bind(v))(); s.vars['second'] = second; // step \ncall(v.mark.bind(v), 'value')(second); \ncall(v.mark.bind(v), 'value')(second + 1); \n}\nclass Vault {\nt = undefined;\nnext = 0;\nconstructor() {\nthis.t = new Turtle(2, 2); // step\nthis.next = 1; // step\n}\n\ntake() {\nlet old = this.next; s.vars['old'] = old; // step\nthis.next++; // step\nreturn old;\n}\nmark(value) {\nif (value == this.next) {\nthis.t.左を向く(); // step\n} else {\nthis.t.右を向く(); // step\n}\nthis.t.前に進む(); // step\n}\n\n}\nmain();",
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
