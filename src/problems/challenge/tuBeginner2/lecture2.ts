import type { ChallengeBase } from '../types';

export const lecture2: ChallengeBase[] = [
  {
    id: 'challengeII2ConsumeMoves',
    title: '残り回数を使うたびに減らす',
    courseId: 'tuBeginner2',
    lectureIndex: 1,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Budget b = new Budget(2); // caller\n    b.use(); // caller\n    b.t.右を向く(); // step\n    b.use(); // caller\n    b.use(); // caller\n    b.t.左を向く(); // step\n    b.t.後に戻る(); // step\n  }\n}\nclass Budget {\n  Turtle t;\n  int remaining;\n  Budget(int amount) {\n    this.t = new Turtle(2, 2); // step\n    this.remaining = amount; // step\n  }\n  void use() {\n    if (this.remaining > 0) {\n      this.t.前に進む(); // step\n      this.remaining--; // step\n    }\n  }\n}',
    blanks: [
      {
        id: 'Budget',
        before: '    Budget b = new Budget(2); // caller',
        after: '    Budget b = new Budget(@[2]@); // caller',
      },
      {
        id: 'Guard',
        before: '    if (this.remaining > 0) {',
        after: '    if (this.remaining @[>]@ 0) {',
      },
      {
        id: 'Consume',
        before: '      this.remaining--; // step',
        after: '      this.remaining@[--]@; // step',
      },
    ],
    bugs: [
      {
        id: 'Budget',
        before: '    Budget b = new Budget(2); // caller',
        after: '    Budget b = new Budget(1); // caller',
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
        before: '      this.remaining--; // step',
        after: '      this.remaining++; // step',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII2OrientedStart',
    title: 'コンストラクタが決める向き',
    courseId: 'tuBeginner2',
    lectureIndex: 1,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Compass c = new Compass(2, 2); // caller\n    c.advance(); // caller\n    c.t.左を向く(); // step\n    c.advance(); // caller\n    c.t.後に戻る(); // step\n    c.advance(); // caller\n  }\n}\nclass Compass {\n  Turtle t;\n  Compass(int x, int y) {\n    this.t = new Turtle(x, y); // step\n    this.t.右を向く(); // step\n    this.t.前に進む(); // step\n  }\n  void advance() {\n    this.t.前に進む(); // step\n    this.t.左を向く(); // step\n  }\n}',
    blanks: [
      {
        id: 'InitialTurn',
        before: '    this.t.右を向く(); // step',
        after: '    this.t.@[右を向く]@(); // step',
      },
      {
        id: 'MethodTurn',
        before: '    this.t.左を向く(); // step',
        after: '    this.t.@[左を向く]@(); // step',
      },
      {
        id: 'Return',
        before: '    c.t.後に戻る(); // step',
        after: '    c.t.@[後に戻る]@(); // step',
      },
    ],
    bugs: [
      {
        id: 'InitialTurn',
        before: '    this.t.右を向く(); // step',
        after: '    this.t.左を向く(); // step',
        kind: 'logical',
      },
      {
        id: 'MethodTurn',
        before: '    this.t.左を向く(); // step',
        after: '    this.t.右を向く(); // step',
        kind: 'logical',
      },
      {
        id: 'Return',
        before: '    c.t.後に戻る(); // step',
        after: '    c.t.前に進む(); // step',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII2IndependentCounters',
    title: 'それぞれが持つ呼び出し回数',
    courseId: 'tuBeginner2',
    lectureIndex: 1,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Counter a = new Counter(2); // caller\n    Counter b = new Counter(4); // caller\n    a.tick(); // caller\n    b.tick(); // caller\n    a.tick(); // caller\n    a.tick(); // caller\n    b.t.右を向く(); // step\n  }\n}\nclass Counter {\n  Turtle t;\n  int count;\n  Counter(int x) {\n    this.t = new Turtle(x, 2); // step\n    this.count = 0; // step\n  }\n  void tick() {\n    this.count++; // step\n    if (this.count == 2) {\n      this.t.右を向く(); // step\n    }\n    this.t.前に進む(); // step\n  }\n}',
    blanks: [
      {
        id: 'Counter',
        before: '    if (this.count == 2) {',
        after: '    if (this.count == @[2]@) {',
      },
      {
        id: 'Receiver',
        before: '    b.tick(); // caller',
        after: '    @[b]@.tick(); // caller',
      },
      {
        id: 'Increment',
        before: '    this.count++; // step',
        after: '    this.count@[++]@; // step',
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
        before: '    b.tick(); // caller',
        after: '    a.tick(); // caller',
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
    id: 'challengeII2FieldParameter',
    title: '引数とフィールドに同じ名前',
    courseId: 'tuBeginner2',
    lectureIndex: 1,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Memory m = new Memory(1); // caller\n    m.store(2); // caller\n    m.t.右を向く(); // step\n    m.store(0); // caller\n    m.t.左を向く(); // step\n    m.store(1); // caller\n    m.t.後に戻る(); // step\n  }\n}\nclass Memory {\n  Turtle t;\n  int size;\n  Memory(int size) {\n    this.t = new Turtle(2, 2); // step\n    this.size = size; // step\n  }\n  void store(int size) {\n    size += this.size; // step\n    this.size = size - 1; // step\n    if (size > 1) {\n      this.t.前に進む(); // step\n    }\n  }\n}',
    blanks: [
      {
        id: 'Shadow',
        before: '    size += this.size; // step',
        after: '    size @[+=]@ this.size; // step',
      },
      {
        id: 'Store',
        before: '    this.size = size - 1; // step',
        after: '    this.size = @[size - 1]@; // step',
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
        before: '    size += this.size; // step',
        after: '    size = this.size; // step',
        kind: 'logical',
      },
      {
        id: 'Store',
        before: '    this.size = size - 1; // step',
        after: '    this.size = 0; // step',
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
    java: 'public class Main {\n  public static void main(String[] args) {\n    Turtle t = new Turtle(2, 2); // step\n    Partner p = new Partner(t); // caller\n    t.前に進む(); // step\n    p.corner(); // caller\n    t.後に戻る(); // step\n    p.corner(); // caller\n    t.左を向く(); // step\n    t.前に進む(); // step\n  }\n}\nclass Partner {\n  Turtle partner;\n  Partner(Turtle source) {\n    this.partner = source; // step\n  }\n  void corner() {\n    this.partner.右を向く(); // step\n    this.partner.前に進む(); // step\n    this.partner.左を向く(); // step\n  }\n}',
    blanks: [
      {
        id: 'Reference',
        before: '    this.partner = source; // step',
        after: '    this.partner = @[source]@; // step',
      },
      {
        id: 'Corner',
        before: '    this.partner.右を向く(); // step',
        after: '    this.partner.@[右を向く]@(); // step',
      },
      {
        id: 'Motion',
        before: '    this.partner.前に進む(); // step',
        after: '    this.partner.@[前に進む]@(); // step',
      },
    ],
    bugs: [
      {
        id: 'Reference',
        before: '    this.partner = source; // step',
        after: '    this.partner = new Turtle(2, 2, "R"); // step',
        kind: 'logical',
      },
      {
        id: 'Corner',
        before: '    this.partner.右を向く(); // step',
        after: '    this.partner.左を向く(); // step',
        kind: 'logical',
      },
      {
        id: 'Motion',
        before: '    this.partner.前に進む(); // step',
        after: '    this.partner.右を向く(); // step',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII2DelayedRequest',
    title: '前の要求を次の呼び出しで使う',
    courseId: 'tuBeginner2',
    lectureIndex: 1,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Delayed d = new Delayed(); // caller\n    d.request(1); // caller\n    d.t.右を向く(); // step\n    d.request(0); // caller\n    d.t.右を向く(); // step\n    d.request(2); // caller\n    d.request(0); // caller\n    d.t.左を向く(); // step\n    d.t.前に進む(); // step\n  }\n}\nclass Delayed {\n  Turtle t;\n  int previous;\n  Delayed() {\n    this.t = new Turtle(2, 2); // step\n    this.previous = 0; // step\n  }\n  void request(int next) {\n    if (this.previous > 0) {\n      this.t.前に進む(); // step\n    }\n    this.previous = next; // step\n  }\n}',
    blanks: [
      {
        id: 'Prior',
        before: '    if (this.previous > 0) {',
        after: '    if (@[this.previous]@ > 0) {',
      },
      {
        id: 'Remember',
        before: '    this.previous = next; // step',
        after: '    this.previous = @[next]@; // step',
      },
      {
        id: 'Request',
        before: '    d.request(2); // caller',
        after: '    d.request(@[2]@); // caller',
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
        before: '    this.previous = next; // step',
        after: '    this.previous = 0; // step',
        kind: 'logical',
      },
      {
        id: 'Request',
        before: '    d.request(2); // caller',
        after: '    d.request(0); // caller',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII2PairedFields',
    title: '進む回数と曲がる条件',
    courseId: 'tuBeginner2',
    lectureIndex: 1,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Signal signal = new Signal(); // caller\n    signal.act(); // caller\n    signal.turn = true; // step\n    signal.act(); // caller\n    signal.turn = false; // step\n    signal.act(); // caller\n    signal.t.後に戻る(); // step\n  }\n}\nclass Signal {\n  Turtle t;\n  boolean turn;\n  int count;\n  Signal() {\n    this.t = new Turtle(2, 2); // step\n    this.turn = false; // step\n    this.count = 0; // step\n  }\n  void act() {\n    if (this.turn) {\n      this.t.右を向く(); // step\n    }\n    this.t.前に進む(); // step\n    this.count++; // step\n  }\n}',
    blanks: [
      {
        id: 'TurnFlag',
        before: '    signal.turn = true; // step',
        after: '    signal.turn = @[true]@; // step',
      },
      {
        id: 'Interpret',
        before: '    if (this.turn) {',
        after: '    if (@[this.turn]@) {',
      },
      {
        id: 'Action',
        before: '    this.t.前に進む(); // step',
        after: '    this.t.@[前に進む]@(); // step',
      },
    ],
    bugs: [
      {
        id: 'TurnFlag',
        before: '    signal.turn = true; // step',
        after: '    signal.turn = false; // step',
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
        before: '    this.t.前に進む(); // step',
        after: '    this.t.右を向く(); // step',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII2DerivedAllowance',
    title: '二つの引数から残り回数を計算',
    courseId: 'tuBeginner2',
    lectureIndex: 1,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Allowance a = new Allowance(3, 1); // caller\n    a.step(); // caller\n    a.t.右を向く(); // step\n    a.step(); // caller\n    a.step(); // caller\n    a.t.左を向く(); // step\n    a.t.後に戻る(); // step\n  }\n}\nclass Allowance {\n  Turtle t;\n  int left;\n  Allowance(int total, int used) {\n    this.t = new Turtle(2, 2); // step\n    this.left = total - used; // step\n  }\n  void step() {\n    if (this.left > 0) {\n      this.left--; // step\n      this.t.前に進む(); // step\n    }\n  }\n}',
    blanks: [
      {
        id: 'Derive',
        before: '    this.left = total - used; // step',
        after: '    this.left = total @[-]@ used; // step',
      },
      {
        id: 'Used',
        before: '    Allowance a = new Allowance(3, 1); // caller',
        after: '    Allowance a = new Allowance(@[3, 1]@); // caller',
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
        before: '    this.left = total - used; // step',
        after: '    this.left = total + used; // step',
        kind: 'logical',
      },
      {
        id: 'Used',
        before: '    Allowance a = new Allowance(3, 1); // caller',
        after: '    Allowance a = new Allowance(3, 2); // caller',
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
    java: 'public class Main {\n  public static void main(String[] args) {\n    Turtle a = new Turtle(2, 2); // step\n    Turtle b = new Turtle(4, 2, "B"); // step\n    Holder h = new Holder(a); // caller\n    h.stroke(); // caller\n    h.t = b; // step\n    h.stroke(); // caller\n    a.左を向く(); // step\n    a.前に進む(); // step\n    h.stroke(); // caller\n  }\n}\nclass Holder {\n  Turtle t;\n  Holder(Turtle initial) {\n    this.t = initial; // step\n  }\n  void stroke() {\n    this.t.前に進む(); // step\n    this.t.右を向く(); // step\n  }\n}',
    blanks: [
      {
        id: 'Field',
        before: '    h.t = b; // step',
        after: '    h.t = @[b]@; // step',
      },
      {
        id: 'Constructor',
        before: '    Holder h = new Holder(a); // caller',
        after: '    Holder h = new Holder@[(a)]@; // caller',
      },
      {
        id: 'Stroke',
        before: '    this.t.右を向く(); // step',
        after: '    this.t.@[右を向く]@(); // step',
      },
    ],
    bugs: [
      {
        id: 'Field',
        before: '    h.t = b; // step',
        after: '    h.t = a; // step',
        kind: 'logical',
      },
      {
        id: 'Constructor',
        before: '    Holder h = new Holder(a); // caller',
        after: '    Holder h = new Holder(b); // caller',
        kind: 'logical',
      },
      {
        id: 'Stroke',
        before: '    this.t.右を向く(); // step',
        after: '    this.t.左を向く(); // step',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII2ComposedAction',
    title: '二つのメソッドが同じ数を使う',
    courseId: 'tuBeginner2',
    lectureIndex: 1,
    java: 'public class Main {\n  public static void main(String[] args) {\n    PairAction p = new PairAction(); // caller\n    p.run(); // caller\n    p.run(); // caller\n    p.t.後に戻る(); // step\n    p.t.左を向く(); // step\n  }\n}\nclass PairAction {\n  Turtle t;\n  int count;\n  PairAction() {\n    this.t = new Turtle(2, 2); // step\n    this.count = 0; // step\n  }\n  void run() {\n    this.mark(); // caller\n    this.choose(); // caller\n  }\n  void mark() {\n    this.count++; // step\n    this.t.前に進む(); // step\n  }\n  void choose() {\n    if (this.count == 1) {\n      this.t.右を向く(); // step\n    } else {\n      this.t.左を向く(); // step\n    }\n    this.t.前に進む(); // step\n  }\n}',
    blanks: [
      {
        id: 'SharedCount',
        before: '    if (this.count == 1) {',
        after: '    if (this.count == @[1]@) {',
      },
      {
        id: 'Mark',
        before: '    this.count++; // step',
        after: '    this.count@[++]@; // step',
      },
      {
        id: 'FirstTurn',
        before: '      this.t.右を向く(); // step',
        after: '      this.t.@[右を向く]@(); // step',
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
        before: '    this.count++; // step',
        after: '    this.count--; // step',
        kind: 'logical',
      },
      {
        id: 'FirstTurn',
        before: '      this.t.右を向く(); // step',
        after: '      this.t.左を向く(); // step',
        kind: 'logical',
      },
    ],
  },
];
