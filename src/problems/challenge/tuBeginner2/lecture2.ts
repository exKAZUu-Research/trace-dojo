import type { ChallengeBase } from '../types';

export const lecture2: ChallengeBase[] = [
  {
    id: 'challengeII2ConsumeMoves',
    title: '残り回数を使うたびに減らす',
    courseId: 'tuBeginner2',
    lectureIndex: 1,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Budget b = new Budget(2);\n    b.use();\n    b.t.右を向く();\n    b.use();\n    b.use();\n    b.t.左を向く();\n    b.t.後に戻る();\n  }\n}\nclass Budget {\n  Turtle t;\n  int remaining;\n  Budget(int amount) {\n    this.t = new Turtle(2, 2);\n    this.remaining = amount;\n  }\n  void use() {\n    if (this.remaining > 0) {\n      this.t.前に進む();\n      this.remaining--;\n    }\n  }\n}',
    blanks: [
      {
        id: 'Budget',
        before: '    Budget b = new Budget(2);',
        after: '    Budget b = new Budget(@[2]@);',
      },
      {
        id: 'Guard',
        before: '    if (this.remaining > 0) {',
        after: '    if (this.remaining @[>]@ 0) {',
      },
      {
        id: 'Consume',
        before: '      this.remaining--;',
        after: '      this.remaining@[--]@;',
      },
    ],
    bugs: [
      {
        id: 'Budget',
        before: '    Budget b = new Budget(2);',
        after: '    Budget b = new Budget(1);',
        kind: 'logical',
      },
      {
        id: 'Guard',
        before: '    if (this.remaining > 0) {',
        after: '    if (this.remaining >= 0) {',
        kind: 'logical',
      },
      {
        id: 'Consume',
        before: '      this.remaining--;',
        after: '      this.remaining++;',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII2OrientedStart',
    title: 'コンストラクタが決める向き',
    courseId: 'tuBeginner2',
    lectureIndex: 1,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Compass c = new Compass(2, 2);\n    c.advance();\n    c.t.左を向く();\n    c.advance();\n    c.t.後に戻る();\n    c.advance();\n  }\n}\nclass Compass {\n  Turtle t;\n  Compass(int x, int y) {\n    this.t = new Turtle(x, y);\n    this.t.右を向く();\n    this.t.前に進む();\n  }\n  void advance() {\n    this.t.前に進む();\n    this.t.左を向く();\n  }\n}',
    blanks: [
      {
        id: 'InitialTurn',
        before: '    this.t.右を向く();',
        after: '    this.t.@[右を向く]@();',
      },
      {
        id: 'MethodTurn',
        before: '    this.t.左を向く();',
        after: '    this.t.@[左を向く]@();',
      },
      {
        id: 'Return',
        before: '    c.t.後に戻る();',
        after: '    c.t.@[後に戻る]@();',
      },
    ],
    bugs: [
      {
        id: 'InitialTurn',
        before: '    this.t.右を向く();',
        after: '    this.t.左を向く();',
        kind: 'logical',
      },
      {
        id: 'MethodTurn',
        before: '    this.t.左を向く();',
        after: '    this.t.右を向く();',
        kind: 'logical',
      },
      {
        id: 'Return',
        before: '    c.t.後に戻る();',
        after: '    c.t.前に進む();',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII2IndependentCounters',
    title: 'それぞれが持つ呼び出し回数',
    courseId: 'tuBeginner2',
    lectureIndex: 1,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Counter a = new Counter(2);\n    Counter b = new Counter(4);\n    a.tick();\n    b.tick();\n    a.tick();\n    a.tick();\n    b.t.右を向く();\n  }\n}\nclass Counter {\n  Turtle t;\n  int count;\n  Counter(int x) {\n    this.t = new Turtle(x, 2);\n    this.count = 0;\n  }\n  void tick() {\n    this.count++;\n    if (this.count == 2) {\n      this.t.右を向く();\n    }\n    this.t.前に進む();\n  }\n}',
    blanks: [
      {
        id: 'Counter',
        before: '    if (this.count == 2) {',
        after: '    if (this.count == @[2]@) {',
      },
      {
        id: 'Receiver',
        before: '    b.tick();',
        after: '    @[b]@.tick();',
      },
      {
        id: 'Increment',
        before: '    this.count++;',
        after: '    this.count@[++]@;',
      },
    ],
    bugs: [
      {
        id: 'Counter',
        before: '    if (this.count == 2) {',
        after: '    if (this.count == 1) {',
        kind: 'logical',
      },
      {
        id: 'Receiver',
        before: '    b.tick();',
        after: '    a.tick();',
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
    id: 'challengeII2FieldParameter',
    title: '引数とフィールドに同じ名前',
    courseId: 'tuBeginner2',
    lectureIndex: 1,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Memory m = new Memory(1);\n    m.store(2);\n    m.t.右を向く();\n    m.store(0);\n    m.t.左を向く();\n    m.store(1);\n    m.t.後に戻る();\n  }\n}\nclass Memory {\n  Turtle t;\n  int size;\n  Memory(int size) {\n    this.t = new Turtle(2, 2);\n    this.size = size;\n  }\n  void store(int size) {\n    size += this.size;\n    this.size = size - 1;\n    if (size > 1) {\n      this.t.前に進む();\n    }\n  }\n}',
    blanks: [
      {
        id: 'Shadow',
        before: '    size += this.size;',
        after: '    size @[+=]@ this.size;',
      },
      {
        id: 'Store',
        before: '    this.size = size - 1;',
        after: '    this.size = @[size - 1]@;',
      },
      {
        id: 'ParameterGuard',
        before: '    if (size > 1) {',
        after: '    if (@[size]@ > 1) {',
      },
    ],
    bugs: [
      {
        id: 'Shadow',
        before: '    size += this.size;',
        after: '    size = this.size;',
        kind: 'logical',
      },
      {
        id: 'Store',
        before: '    this.size = size - 1;',
        after: '    this.size = 0;',
        kind: 'logical',
      },
      {
        id: 'ParameterGuard',
        before: '    if (size > 1) {',
        after: '    if (this.size > 1) {',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII2StoredPartner',
    title: '渡された亀をフィールドに保存',
    courseId: 'tuBeginner2',
    lectureIndex: 1,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Turtle t = new Turtle(2, 2);\n    Partner p = new Partner(t);\n    t.前に進む();\n    p.corner();\n    t.後に戻る();\n    p.corner();\n    t.左を向く();\n    t.前に進む();\n  }\n}\nclass Partner {\n  Turtle partner;\n  Partner(Turtle source) {\n    this.partner = source;\n  }\n  void corner() {\n    this.partner.右を向く();\n    this.partner.前に進む();\n    this.partner.左を向く();\n  }\n}',
    blanks: [
      {
        id: 'Reference',
        before: '    this.partner = source;',
        after: '    this.partner = @[source]@;',
      },
      {
        id: 'Corner',
        before: '    this.partner.右を向く();',
        after: '    this.partner.@[右を向く]@();',
      },
      {
        id: 'Motion',
        before: '    this.partner.前に進む();',
        after: '    this.partner.@[前に進む]@();',
      },
    ],
    bugs: [
      {
        id: 'Reference',
        before: '    this.partner = source;',
        after: '    this.partner = new Turtle(2, 2, "R");',
        kind: 'logical',
      },
      {
        id: 'Corner',
        before: '    this.partner.右を向く();',
        after: '    this.partner.左を向く();',
        kind: 'logical',
      },
      {
        id: 'Motion',
        before: '    this.partner.前に進む();',
        after: '    this.partner.右を向く();',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII2DelayedRequest',
    title: '前の要求を次の呼び出しで使う',
    courseId: 'tuBeginner2',
    lectureIndex: 1,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Delayed d = new Delayed();\n    d.request(1);\n    d.t.右を向く();\n    d.request(0);\n    d.t.右を向く();\n    d.request(2);\n    d.request(0);\n    d.t.左を向く();\n    d.t.前に進む();\n  }\n}\nclass Delayed {\n  Turtle t;\n  int previous;\n  Delayed() {\n    this.t = new Turtle(2, 2);\n    this.previous = 0;\n  }\n  void request(int next) {\n    if (this.previous > 0) {\n      this.t.前に進む();\n    }\n    this.previous = next;\n  }\n}',
    blanks: [
      {
        id: 'Prior',
        before: '    if (this.previous > 0) {',
        after: '    if (@[this.previous]@ > 0) {',
      },
      {
        id: 'Remember',
        before: '    this.previous = next;',
        after: '    this.previous = @[next]@;',
      },
      {
        id: 'Request',
        before: '    d.request(2);',
        after: '    d.request(@[2]@);',
      },
    ],
    bugs: [
      {
        id: 'Prior',
        before: '    if (this.previous > 0) {',
        after: '    if (next > 0) {',
        kind: 'logical',
      },
      {
        id: 'Remember',
        before: '    this.previous = next;',
        after: '    this.previous = 0;',
        kind: 'logical',
      },
      {
        id: 'Request',
        before: '    d.request(2);',
        after: '    d.request(0);',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII2PairedFields',
    title: '進む回数と曲がる条件',
    courseId: 'tuBeginner2',
    lectureIndex: 1,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Signal signal = new Signal();\n    signal.act();\n    signal.turn = true;\n    signal.act();\n    signal.turn = false;\n    signal.act();\n    signal.t.後に戻る();\n  }\n}\nclass Signal {\n  Turtle t;\n  boolean turn;\n  int count;\n  Signal() {\n    this.t = new Turtle(2, 2);\n    this.turn = false;\n    this.count = 0;\n  }\n  void act() {\n    if (this.turn) {\n      this.t.右を向く();\n    }\n    this.t.前に進む();\n    this.count++;\n  }\n}',
    blanks: [
      {
        id: 'TurnFlag',
        before: '    signal.turn = true;',
        after: '    signal.turn = @[true]@;',
      },
      {
        id: 'Interpret',
        before: '    if (this.turn) {',
        after: '    if (@[this.turn]@) {',
      },
      {
        id: 'Action',
        before: '    this.t.前に進む();',
        after: '    this.t.@[前に進む]@();',
      },
    ],
    bugs: [
      {
        id: 'TurnFlag',
        before: '    signal.turn = true;',
        after: '    signal.turn = false;',
        kind: 'logical',
      },
      {
        id: 'Interpret',
        before: '    if (this.turn) {',
        after: '    if (!this.turn) {',
        kind: 'logical',
      },
      {
        id: 'Action',
        before: '    this.t.前に進む();',
        after: '    this.t.右を向く();',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII2DerivedAllowance',
    title: '二つの引数から残り回数を計算',
    courseId: 'tuBeginner2',
    lectureIndex: 1,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Allowance a = new Allowance(3, 1);\n    a.step();\n    a.t.右を向く();\n    a.step();\n    a.step();\n    a.t.左を向く();\n    a.t.後に戻る();\n  }\n}\nclass Allowance {\n  Turtle t;\n  int left;\n  Allowance(int total, int used) {\n    this.t = new Turtle(2, 2);\n    this.left = total - used;\n  }\n  void step() {\n    if (this.left > 0) {\n      this.left--;\n      this.t.前に進む();\n    }\n  }\n}',
    blanks: [
      {
        id: 'Derive',
        before: '    this.left = total - used;',
        after: '    this.left = total @[-]@ used;',
      },
      {
        id: 'Used',
        before: '    Allowance a = new Allowance(3, 1);',
        after: '    Allowance a = new Allowance(@[3, 1]@);',
      },
      {
        id: 'Compare',
        before: '    if (this.left > 0) {',
        after: '    if (this.left @[>]@ 0) {',
      },
    ],
    bugs: [
      {
        id: 'Derive',
        before: '    this.left = total - used;',
        after: '    this.left = total + used;',
        kind: 'logical',
      },
      {
        id: 'Used',
        before: '    Allowance a = new Allowance(3, 1);',
        after: '    Allowance a = new Allowance(3, 2);',
        kind: 'logical',
      },
      {
        id: 'Compare',
        before: '    if (this.left > 0) {',
        after: '    if (this.left >= 0) {',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII2ReplaceField',
    title: '途中で亀のフィールドを交換',
    courseId: 'tuBeginner2',
    lectureIndex: 1,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Turtle a = new Turtle(2, 2);\n    Turtle b = new Turtle(4, 2, "B");\n    Holder h = new Holder(a);\n    h.stroke();\n    h.t = b;\n    h.stroke();\n    a.左を向く();\n    a.前に進む();\n    h.stroke();\n  }\n}\nclass Holder {\n  Turtle t;\n  Holder(Turtle initial) {\n    this.t = initial;\n  }\n  void stroke() {\n    this.t.前に進む();\n    this.t.右を向く();\n  }\n}',
    blanks: [
      {
        id: 'Field',
        before: '    h.t = b;',
        after: '    h.t = @[b]@;',
      },
      {
        id: 'Constructor',
        before: '    Holder h = new Holder(a);',
        after: '    Holder h = new Holder@[(a)]@;',
      },
      {
        id: 'Stroke',
        before: '    this.t.右を向く();',
        after: '    this.t.@[右を向く]@();',
      },
    ],
    bugs: [
      {
        id: 'Field',
        before: '    h.t = b;',
        after: '    h.t = a;',
        kind: 'logical',
      },
      {
        id: 'Constructor',
        before: '    Holder h = new Holder(a);',
        after: '    Holder h = new Holder(b);',
        kind: 'logical',
      },
      {
        id: 'Stroke',
        before: '    this.t.右を向く();',
        after: '    this.t.左を向く();',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII2ComposedAction',
    title: '二つのメソッドが同じ数を使う',
    courseId: 'tuBeginner2',
    lectureIndex: 1,
    java: 'public class Main {\n  public static void main(String[] args) {\n    PairAction p = new PairAction();\n    p.run();\n    p.run();\n    p.t.後に戻る();\n    p.t.左を向く();\n  }\n}\nclass PairAction {\n  Turtle t;\n  int count;\n  PairAction() {\n    this.t = new Turtle(2, 2);\n    this.count = 0;\n  }\n  void run() {\n    this.mark();\n    this.choose();\n  }\n  void mark() {\n    this.count++;\n    this.t.前に進む();\n  }\n  void choose() {\n    if (this.count == 1) {\n      this.t.右を向く();\n    } else {\n      this.t.左を向く();\n    }\n    this.t.前に進む();\n  }\n}',
    blanks: [
      {
        id: 'SharedCount',
        before: '    if (this.count == 1) {',
        after: '    if (this.count == @[1]@) {',
      },
      {
        id: 'Mark',
        before: '    this.count++;',
        after: '    this.count@[++]@;',
      },
      {
        id: 'FirstTurn',
        before: '      this.t.右を向く();',
        after: '      this.t.@[右を向く]@();',
      },
    ],
    bugs: [
      {
        id: 'SharedCount',
        before: '    if (this.count == 1) {',
        after: '    if (this.count == 2) {',
        kind: 'logical',
      },
      {
        id: 'Mark',
        before: '    this.count++;',
        after: '    this.count--;',
        kind: 'logical',
      },
      {
        id: 'FirstTurn',
        before: '      this.t.右を向く();',
        after: '      this.t.左を向く();',
        kind: 'logical',
      },
    ],
  },
];
