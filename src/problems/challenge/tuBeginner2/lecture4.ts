import type { ChallengeBase } from '../types';

export const lecture4: ChallengeBase[] = [
  {
    id: 'challengeII4ConstructionTotal',
    title: '作った後で共有の個数を読む',
    courseId: 'tuBeginner2',
    lectureIndex: 3,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Shared a = new Shared(2); // caller\n    a.mark(); // caller\n    Shared b = new Shared(4); // caller\n    a.mark(); // caller\n    b.mark(); // caller\n    b.t.左を向く(); // step\n    b.t.前に進む(); // step\n  }\n}\nclass Shared {\n  Turtle t;\n  static int total = 0;\n  Shared(int x) {\n    this.t = new Turtle(x, 2); // step\n    Shared.total++; // step\n  }\n\n  void mark() {\n    if (Shared.total == 2) {\n      this.t.右を向く(); // step\n    }\n    this.t.前に進む(); // step\n  }\n\n}',
    instrumented:
      "function main() {\nlet a = call(Shared, 'x')(2); registerDisplayRef('a', () => a); \ncall(a.mark.bind(a))(); \nlet b = call(Shared, 'x')(4); registerDisplayRef('b', () => b); \ncall(a.mark.bind(a))(); \ncall(b.mark.bind(b))(); \nb.t.左を向く(); myGlobal['Shared.total'] = Shared.total; // step\nb.t.前に進む(); myGlobal['Shared.total'] = Shared.total; // step\n}\nclass Shared {\nt = undefined;\nstatic total = 0;\nconstructor(x) {\nthis.t = new Turtle(x, 2); myGlobal['Shared.total'] = Shared.total; // step\nShared.total++; myGlobal['Shared.total'] = Shared.total; // step\n}\n\nmark() {\nif (Shared.total == 2) {\nthis.t.右を向く(); myGlobal['Shared.total'] = Shared.total; // step\n}\nthis.t.前に進む(); myGlobal['Shared.total'] = Shared.total; // step\n}\n\n}\nmain();",
    blanks: [
      {
        id: 'Count',
        before: '    Shared.total++; // step',
        after: '    Shared.total@[++]@; // step',
      },
      {
        id: 'Read',
        before: '    if (Shared.total == 2) {',
        after: '    if (Shared.total == @[2]@) {',
      },
      {
        id: 'Later',
        before: '    a.mark(); // caller\n    b.mark(); // caller',
        after: '    @[a.mark()]@; // caller\n    b.mark(); // caller',
      },
    ],
    bugs: [
      {
        id: 'Count',
        before: '    Shared.total++; // step',
        after: '    Shared.total--; // step',
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
        before: '    a.mark(); // caller\n    b.mark(); // caller',
        after: '    b.mark(); // caller\n    b.mark(); // caller',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII4CommonBudget',
    title: '二つのインスタンスで残りを分ける',
    courseId: 'tuBeginner2',
    lectureIndex: 3,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Shared a = new Shared(2); // caller\n    Shared b = new Shared(4); // caller\n    a.use(); // caller\n    b.use(); // caller\n    a.use(); // caller\n    b.use(); // caller\n  }\n}\nclass Shared {\n  Turtle t;\n  static int left = 3;\n  Shared(int x) {\n    this.t = new Turtle(x, 2); // step\n    this.t.右を向く(); // step\n  }\n\n  void use() {\n    if (Shared.left > 0) {\n      this.t.前に進む(); // step\n      Shared.left--; // step\n    }\n    this.t.左を向く(); // step\n  }\n\n}',
    instrumented:
      "function main() {\nlet a = call(Shared, 'x')(2); registerDisplayRef('a', () => a); \nlet b = call(Shared, 'x')(4); registerDisplayRef('b', () => b); \ncall(a.use.bind(a))(); \ncall(b.use.bind(b))(); \ncall(a.use.bind(a))(); \ncall(b.use.bind(b))(); \n}\nclass Shared {\nt = undefined;\nstatic left = 3;\nconstructor(x) {\nthis.t = new Turtle(x, 2); myGlobal['Shared.left'] = Shared.left; // step\nthis.t.右を向く(); myGlobal['Shared.left'] = Shared.left; // step\n}\n\nuse() {\nif (Shared.left > 0) {\nthis.t.前に進む(); myGlobal['Shared.left'] = Shared.left; // step\nShared.left--; myGlobal['Shared.left'] = Shared.left; // step\n}\nthis.t.左を向く(); myGlobal['Shared.left'] = Shared.left; // step\n}\n\n}\nmain();",
    blanks: [
      {
        id: 'Shared',
        before: '      Shared.left--; // step',
        after: '      Shared.left@[--]@; // step',
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
        before: '      Shared.left--; // step',
        after: '      Shared.left++; // step',
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
    java: 'public class Main {\n  public static void main(String[] args) {\n    Shared a = new Shared(2); // caller\n    Shared.defaultMode = 2; // step\n    Shared b = new Shared(4); // caller\n    a.move(); // caller\n    b.move(); // caller\n    a.move(); // caller\n  }\n}\nclass Shared {\n  Turtle t;\n  static int defaultMode = 1;\n  int mode;\n  Shared(int x) {\n    this.t = new Turtle(x, 2); // step\n    this.mode = Shared.defaultMode; // step\n  }\n\n  void move() {\n    if (this.mode == 1) {\n      this.t.右を向く(); // step\n    } else {\n      this.t.左を向く(); // step\n    }\n    this.t.前に進む(); // step\n  }\n\n}',
    instrumented:
      "function main() {\nlet a = call(Shared, 'x')(2); registerDisplayRef('a', () => a); \nShared.defaultMode = 2; myGlobal['Shared.defaultMode'] = Shared.defaultMode; // step\nlet b = call(Shared, 'x')(4); registerDisplayRef('b', () => b); \ncall(a.move.bind(a))(); \ncall(b.move.bind(b))(); \ncall(a.move.bind(a))(); \n}\nclass Shared {\nt = undefined;\nstatic defaultMode = 1;\nmode = 0;\nconstructor(x) {\nthis.t = new Turtle(x, 2); myGlobal['Shared.defaultMode'] = Shared.defaultMode; // step\nthis.mode = Shared.defaultMode; myGlobal['Shared.defaultMode'] = Shared.defaultMode; // step\n}\n\nmove() {\nif (this.mode == 1) {\nthis.t.右を向く(); myGlobal['Shared.defaultMode'] = Shared.defaultMode; // step\n} else {\nthis.t.左を向く(); myGlobal['Shared.defaultMode'] = Shared.defaultMode; // step\n}\nthis.t.前に進む(); myGlobal['Shared.defaultMode'] = Shared.defaultMode; // step\n}\n\n}\nmain();",
    blanks: [
      {
        id: 'Snapshot',
        before: '    if (this.mode == 1) {',
        after: '    if (@[this.mode]@ == 1) {',
      },
      {
        id: 'Default',
        before: '    Shared.defaultMode = 2; // step',
        after: '    Shared.defaultMode = @[2]@; // step',
      },
      {
        id: 'Copy',
        before: '    this.mode = Shared.defaultMode; // step',
        after: '    this.mode = @[Shared.defaultMode]@; // step',
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
        before: '    Shared.defaultMode = 2; // step',
        after: '    Shared.defaultMode = 1; // step',
        kind: 'logical',
      },
      {
        id: 'Copy',
        before: '    this.mode = Shared.defaultMode; // step',
        after: '    this.mode = 2; // step',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII4ResetShared',
    title: '共有カウンタをリセットする',
    courseId: 'tuBeginner2',
    lectureIndex: 3,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Shared a = new Shared(2); // caller\n    Shared b = new Shared(4); // caller\n    a.act(); // caller\n    b.act(); // caller\n    Shared.reset(); // caller\n    b.act(); // caller\n  }\n}\nclass Shared {\n  Turtle t;\n  static int count = 0;\n  Shared(int x) {\n    this.t = new Turtle(x, 2); // step\n    this.t.右を向く(); // step\n  }\n\n  static void reset() {\n    Shared.count = 0; // step\n  }\n  void act() {\n    Shared.count++; // step\n    if (Shared.count == 1) {\n      this.t.左を向く(); // step\n    }\n    this.t.前に進む(); // step\n  }\n\n}',
    instrumented:
      "function main() {\nlet a = call(Shared, 'x')(2); registerDisplayRef('a', () => a); \nlet b = call(Shared, 'x')(4); registerDisplayRef('b', () => b); \ncall(a.act.bind(a))(); \ncall(b.act.bind(b))(); \ncall(Shared.reset.bind(Shared))(); \ncall(b.act.bind(b))(); \n}\nclass Shared {\nt = undefined;\nstatic count = 0;\nconstructor(x) {\nthis.t = new Turtle(x, 2); myGlobal['Shared.count'] = Shared.count; // step\nthis.t.右を向く(); myGlobal['Shared.count'] = Shared.count; // step\n}\n\nstatic reset() {\nShared.count = 0; myGlobal['Shared.count'] = Shared.count; // step\n}\nact() {\nShared.count++; myGlobal['Shared.count'] = Shared.count; // step\nif (Shared.count == 1) {\nthis.t.左を向く(); myGlobal['Shared.count'] = Shared.count; // step\n}\nthis.t.前に進む(); myGlobal['Shared.count'] = Shared.count; // step\n}\n\n}\nmain();",
    blanks: [
      {
        id: 'Reset',
        before: '    Shared.count = 0; // step',
        after: '    Shared.count = @[0]@; // step',
      },
      {
        id: 'Compare',
        before: '    if (Shared.count == 1) {',
        after: '    if (Shared.count == @[1]@) {',
      },
      {
        id: 'Update',
        before: '    Shared.count++; // step',
        after: '    Shared.count@[++]@; // step',
      },
    ],
    bugs: [
      {
        id: 'Reset',
        before: '    Shared.count = 0; // step',
        after: '    Shared.count = 2; // step',
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
        before: '    Shared.count++; // step',
        after: '    Shared.count--; // step',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII4PairUtility',
    title: '二つの亀を静的メソッドへ渡す',
    courseId: 'tuBeginner2',
    lectureIndex: 3,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Turtle a = new Turtle(2, 2); // step\n    Turtle b = new Turtle(4, 2, "B"); // step\n    Utility.cross(a, b); // caller\n    a.前に進む(); // step\n    b.後に戻る(); // step\n    Utility.cross(b, a); // caller\n  }\n}\nclass Utility {\n  static void cross(Turtle first, Turtle second) {\n    first.右を向く(); // step\n    second.左を向く(); // step\n    first.前に進む(); // step\n    second.前に進む(); // step\n  }\n}',
    instrumented:
      "function main() {\nlet a = new Turtle(2, 2); registerDisplayRef('a', () => a);  // step\nlet b = new Turtle(4, 2, \"B\"); registerDisplayRef('b', () => b);  // step\ncall(Utility.cross.bind(Utility), 'first', 'second')(a, b); \na.前に進む();  // step\nb.後に戻る();  // step\ncall(Utility.cross.bind(Utility), 'first', 'second')(b, a); \n}\nclass Utility {\nstatic cross(first, second) {\nfirst.右を向く();  // step\nsecond.左を向く();  // step\nfirst.前に進む();  // step\nsecond.前に進む();  // step\n}\n}\nmain();",
    blanks: [
      {
        id: 'Order',
        before: '    Utility.cross(b, a); // caller',
        after: '    Utility.cross(@[b, a]@); // caller',
      },
      {
        id: 'First',
        before: '    first.右を向く(); // step',
        after: '    first.@[右を向く]@(); // step',
      },
      {
        id: 'Second',
        before: '    second.前に進む(); // step',
        after: '    second.@[前に進む]@(); // step',
      },
    ],
    bugs: [
      {
        id: 'Order',
        before: '    Utility.cross(b, a); // caller',
        after: '    Utility.cross(a, b); // caller',
        kind: 'logical',
      },
      {
        id: 'First',
        before: '    first.右を向く(); // step',
        after: '    first.左を向く(); // step',
        kind: 'logical',
      },
      {
        id: 'Second',
        before: '    second.前に進む(); // step',
        after: '    second.後に戻る(); // step',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII4SharedMode',
    title: '一方が変えたモードをもう一方で使う',
    courseId: 'tuBeginner2',
    lectureIndex: 3,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Shared a = new Shared(2); // caller\n    Shared b = new Shared(4); // caller\n    a.move(); // caller\n    a.flip(); // caller\n    b.move(); // caller\n    b.flip(); // caller\n    a.move(); // caller\n  }\n}\nclass Shared {\n  Turtle t;\n  static boolean right = true;\n  Shared(int x) {\n    this.t = new Turtle(x, 2); // step\n    this.t.前に進む(); // step\n  }\n\n  void flip() {\n    Shared.right = !Shared.right; // step\n  }\n  void move() {\n    if (Shared.right) {\n      this.t.右を向く(); // step\n    } else {\n      this.t.左を向く(); // step\n    }\n    this.t.前に進む(); // step\n  }\n\n}',
    instrumented:
      "function main() {\nlet a = call(Shared, 'x')(2); registerDisplayRef('a', () => a); \nlet b = call(Shared, 'x')(4); registerDisplayRef('b', () => b); \ncall(a.move.bind(a))(); \ncall(a.flip.bind(a))(); \ncall(b.move.bind(b))(); \ncall(b.flip.bind(b))(); \ncall(a.move.bind(a))(); \n}\nclass Shared {\nt = undefined;\nstatic right = true;\nconstructor(x) {\nthis.t = new Turtle(x, 2); myGlobal['Shared.right'] = Shared.right; // step\nthis.t.前に進む(); myGlobal['Shared.right'] = Shared.right; // step\n}\n\nflip() {\nShared.right = !Shared.right; myGlobal['Shared.right'] = Shared.right; // step\n}\nmove() {\nif (Shared.right) {\nthis.t.右を向く(); myGlobal['Shared.right'] = Shared.right; // step\n} else {\nthis.t.左を向く(); myGlobal['Shared.right'] = Shared.right; // step\n}\nthis.t.前に進む(); myGlobal['Shared.right'] = Shared.right; // step\n}\n\n}\nmain();",
    blanks: [
      {
        id: 'Flip',
        before: '    Shared.right = !Shared.right; // step',
        after: '    Shared.right = @[!Shared.right]@; // step',
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
        before: '    Shared.right = !Shared.right; // step',
        after: '    Shared.right = Shared.right; // step',
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
    java: 'public class Main {\n  public static void main(String[] args) {\n    Shared a = new Shared(2); // caller\n    Shared b = new Shared(4); // caller\n    a.act(); // caller\n    b.act(); // caller\n    a.act(); // caller\n  }\n}\nclass Shared {\n  Turtle t;\n  static int total = 0;\n  int own;\n  Shared(int x) {\n    this.t = new Turtle(x, 2); // step\n    this.own = 0; // step\n  }\n\n  void act() {\n    this.own++; // step\n    Shared.total++; // step\n    if (this.own == Shared.total) {\n      this.t.右を向く(); // step\n    }\n    this.t.前に進む(); // step\n  }\n\n}',
    instrumented:
      "function main() {\nlet a = call(Shared, 'x')(2); registerDisplayRef('a', () => a); \nlet b = call(Shared, 'x')(4); registerDisplayRef('b', () => b); \ncall(a.act.bind(a))(); \ncall(b.act.bind(b))(); \ncall(a.act.bind(a))(); \n}\nclass Shared {\nt = undefined;\nstatic total = 0;\nown = 0;\nconstructor(x) {\nthis.t = new Turtle(x, 2); myGlobal['Shared.total'] = Shared.total; // step\nthis.own = 0; myGlobal['Shared.total'] = Shared.total; // step\n}\n\nact() {\nthis.own++; myGlobal['Shared.total'] = Shared.total; // step\nShared.total++; myGlobal['Shared.total'] = Shared.total; // step\nif (this.own == Shared.total) {\nthis.t.右を向く(); myGlobal['Shared.total'] = Shared.total; // step\n}\nthis.t.前に進む(); myGlobal['Shared.total'] = Shared.total; // step\n}\n\n}\nmain();",
    blanks: [
      {
        id: 'Own',
        before: '    this.own++; // step',
        after: '    this.own@[++]@; // step',
      },
      {
        id: 'Total',
        before: '    Shared.total++; // step',
        after: '    Shared.total@[++]@; // step',
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
        before: '    this.own++; // step',
        after: '    this.own--; // step',
        kind: 'logical',
      },
      {
        id: 'Total',
        before: '    Shared.total++; // step',
        after: '    Shared.total--; // step',
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
    java: 'public class Main {\n  public static void main(String[] args) {\n    int first = Offset.position(1); // step // caller\n    Turtle a = new Turtle(first, 2); // step\n    Offset.shift = 2; // step\n    int second = Offset.position(1); // step // caller\n    Turtle b = new Turtle(second, 2, "R"); // step\n    a.前に進む(); // step\n    b.右を向く(); // step\n    b.前に進む(); // step\n    a.左を向く(); // step\n    a.前に進む(); // step\n    b.左を向く(); // step\n    b.前に進む(); // step\n  }\n}\nclass Offset {\n  static int shift = 1;\n  static int position(int origin) {\n    return origin + Offset.shift;\n  }\n}',
    instrumented:
      "function main() {\nlet first = call(Offset.position.bind(Offset), 'origin')(1); s.vars['first'] = first; myGlobal['Offset.shift'] = Offset.shift; // step \nlet a = new Turtle(first, 2); registerDisplayRef('a', () => a); myGlobal['Offset.shift'] = Offset.shift; // step\nOffset.shift = 2; myGlobal['Offset.shift'] = Offset.shift; // step\nlet second = call(Offset.position.bind(Offset), 'origin')(1); s.vars['second'] = second; myGlobal['Offset.shift'] = Offset.shift; // step \nlet b = new Turtle(second, 2, \"R\"); registerDisplayRef('b', () => b); myGlobal['Offset.shift'] = Offset.shift; // step\na.前に進む(); myGlobal['Offset.shift'] = Offset.shift; // step\nb.右を向く(); myGlobal['Offset.shift'] = Offset.shift; // step\nb.前に進む(); myGlobal['Offset.shift'] = Offset.shift; // step\na.左を向く(); myGlobal['Offset.shift'] = Offset.shift; // step\na.前に進む(); myGlobal['Offset.shift'] = Offset.shift; // step\nb.左を向く(); myGlobal['Offset.shift'] = Offset.shift; // step\nb.前に進む(); myGlobal['Offset.shift'] = Offset.shift; // step\n}\nclass Offset {\nstatic shift = 1;\nstatic position(origin) {\nreturn origin + Offset.shift;\n}\n}\nmain();",
    blanks: [
      {
        id: 'Calculation',
        before: '    return origin + Offset.shift;',
        after: '    return origin @[+]@ Offset.shift;',
      },
      {
        id: 'Change',
        before: '    Offset.shift = 2; // step',
        after: '    Offset.shift = @[2]@; // step',
      },
      {
        id: 'Saved',
        before: '    Turtle a = new Turtle(first, 2); // step',
        after: '    Turtle a = new Turtle(@[first]@, 2); // step',
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
        before: '    Offset.shift = 2; // step',
        after: '    Offset.shift = 3; // step',
        kind: 'logical',
      },
      {
        id: 'Saved',
        before: '    Turtle a = new Turtle(first, 2); // step',
        after: '    Turtle a = new Turtle(first + 1, 2); // step',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII4IssuedNumber',
    title: '生成順の番号をインスタンスへ保存',
    courseId: 'tuBeginner2',
    lectureIndex: 3,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Shared a = new Shared(2); // caller\n    Shared b = new Shared(4); // caller\n    a.mark(); // caller\n    b.mark(); // caller\n    a.mark(); // caller\n  }\n}\nclass Shared {\n  Turtle t;\n  static int sequence = 0;\n  int number;\n  Shared(int x) {\n    this.t = new Turtle(x, 2); // step\n    this.number = Shared.sequence; // step\n    Shared.sequence++; // step\n  }\n\n  void mark() {\n    if (this.number == 0) {\n      this.t.右を向く(); // step\n    } else {\n      this.t.左を向く(); // step\n    }\n    this.t.前に進む(); // step\n  }\n\n}',
    instrumented:
      "function main() {\nlet a = call(Shared, 'x')(2); registerDisplayRef('a', () => a); \nlet b = call(Shared, 'x')(4); registerDisplayRef('b', () => b); \ncall(a.mark.bind(a))(); \ncall(b.mark.bind(b))(); \ncall(a.mark.bind(a))(); \n}\nclass Shared {\nt = undefined;\nstatic sequence = 0;\nnumber = 0;\nconstructor(x) {\nthis.t = new Turtle(x, 2); myGlobal['Shared.sequence'] = Shared.sequence; // step\nthis.number = Shared.sequence; myGlobal['Shared.sequence'] = Shared.sequence; // step\nShared.sequence++; myGlobal['Shared.sequence'] = Shared.sequence; // step\n}\n\nmark() {\nif (this.number == 0) {\nthis.t.右を向く(); myGlobal['Shared.sequence'] = Shared.sequence; // step\n} else {\nthis.t.左を向く(); myGlobal['Shared.sequence'] = Shared.sequence; // step\n}\nthis.t.前に進む(); myGlobal['Shared.sequence'] = Shared.sequence; // step\n}\n\n}\nmain();",
    blanks: [
      {
        id: 'Issue',
        before: '    this.number = Shared.sequence; // step',
        after: '    this.number = @[Shared.sequence]@; // step',
      },
      {
        id: 'Increment',
        before: '    Shared.sequence++; // step',
        after: '    Shared.sequence@[++]@; // step',
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
        before: '    this.number = Shared.sequence; // step',
        after: '    this.number = Shared.sequence + 1; // step',
        kind: 'logical',
      },
      {
        id: 'Increment',
        before: '    Shared.sequence++; // step',
        after: '    Shared.sequence += 0; // step',
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
    java: 'public class Main {\n  public static void main(String[] args) {\n    Shared a = new Shared(2); // caller\n    Shared b = new Shared(4); // caller\n    int saved = Shared.count; // step\n    Shared.increment(); // caller\n    a.compare(saved); // caller\n    b.compare(Shared.count); // caller\n    Shared.increment(); // caller\n    b.compare(saved); // caller\n  }\n}\nclass Shared {\n  Turtle t;\n  static int count = 1;\n  Shared(int x) {\n    this.t = new Turtle(x, 2); // step\n    this.t.右を向く(); // step\n  }\n\n  static void increment() {\n    Shared.count++; // step\n  }\n  void compare(int old) {\n    if (old < Shared.count) {\n      this.t.左を向く(); // step\n    }\n    this.t.前に進む(); // step\n  }\n\n}',
    instrumented:
      "function main() {\nlet a = call(Shared, 'x')(2); registerDisplayRef('a', () => a); \nlet b = call(Shared, 'x')(4); registerDisplayRef('b', () => b); \nlet saved = Shared.count; s.vars['saved'] = saved; myGlobal['Shared.count'] = Shared.count; // step\ncall(Shared.increment.bind(Shared))(); \ncall(a.compare.bind(a), 'old')(saved); \ncall(b.compare.bind(b), 'old')(Shared.count); \ncall(Shared.increment.bind(Shared))(); \ncall(b.compare.bind(b), 'old')(saved); \n}\nclass Shared {\nt = undefined;\nstatic count = 1;\nconstructor(x) {\nthis.t = new Turtle(x, 2); myGlobal['Shared.count'] = Shared.count; // step\nthis.t.右を向く(); myGlobal['Shared.count'] = Shared.count; // step\n}\n\nstatic increment() {\nShared.count++; myGlobal['Shared.count'] = Shared.count; // step\n}\ncompare(old) {\nif (old < Shared.count) {\nthis.t.左を向く(); myGlobal['Shared.count'] = Shared.count; // step\n}\nthis.t.前に進む(); myGlobal['Shared.count'] = Shared.count; // step\n}\n\n}\nmain();",
    blanks: [
      {
        id: 'Snapshot',
        before: '    int saved = Shared.count; // step',
        after: '    int saved = @[Shared.count]@; // step',
      },
      {
        id: 'Increment',
        before: '    Shared.count++; // step',
        after: '    Shared.count@[++]@; // step',
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
        before: '    int saved = Shared.count; // step',
        after: '    int saved = Shared.count + 1; // step',
        kind: 'logical',
      },
      {
        id: 'Increment',
        before: '    Shared.count++; // step',
        after: '    Shared.count--; // step',
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
