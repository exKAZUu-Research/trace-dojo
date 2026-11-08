import type { ChallengeBase } from '../types';

export const lecture5: ChallengeBase[] = [
  {
    id: 'challengeII5ProtectedCounter',
    title: '継承した状態を子クラスから変える',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Boost b = new Boost();\n    b.act();\n    b.boost();\n    b.act();\n    b.act();\n  }\n}\nclass Base {\n  protected Turtle t;\n  protected int count;\n  Base() {\n    this.t = new Turtle(2, 2);\n    this.count = 0;\n  }\n  void act() {\n    this.count++;\n    if (this.count > 2) {\n      this.t.右を向く();\n    }\n    this.t.前に進む();\n  }\n}\nclass Boost extends Base {\n  void boost() {\n    this.count += 2;\n  }\n}',
    blanks: [
      {
        id: 'Boost',
        before: '    this.count += 2;',
        after: '    this.count += @[2]@;',
      },
      {
        id: 'Inherited',
        before: '    if (this.count > 2) {',
        after: '    if (this.count @[>]@ 2) {',
      },
      {
        id: 'Update',
        before: '    this.count++;',
        after: '    this.count@[++]@;',
      },
    ],
    bugs: [
      {
        id: 'Boost',
        before: '    this.count += 2;',
        after: '    this.count += 0;',
        kind: 'logical',
      },
      {
        id: 'Inherited',
        before: '    if (this.count > 2) {',
        after: '    if (this.count < 2) {',
        kind: 'logical',
      },
      {
        id: 'Update',
        before: '    this.count++;',
        after: '    this.count--;',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII5ReverseOrder',
    title: '移動と回転の順をオーバーライドする',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Base a = new Base();\n    Base b = new Reverse();\n    a.act();\n    b.act();\n    a.act();\n    b.act();\n  }\n}\nclass Base {\n  Turtle t;\n  Base() {\n    this.t = new Turtle(2, 2);\n  }\n  void act() {\n    this.t.右を向く();\n    this.t.前に進む();\n  }\n}\nclass Reverse extends Base {\n  void act() {\n    this.t.前に進む();\n    this.t.右を向く();\n  }\n}',
    blanks: [
      {
        id: 'Dynamic',
        before: '    Base b = new Reverse();',
        after: '    Base b = new @[Reverse]@();',
      },
      {
        id: 'Override',
        before: 'class Reverse extends Base {\n  void act() {\n    this.t.前に進む();',
        after: 'class Reverse extends Base {\n  void act() {\n    this.t.@[前に進む]@();',
      },
      {
        id: 'BaseTurn',
        before: '  void act() {\n    this.t.右を向く();',
        after: '  void act() {\n    this.t.@[右を向く]@();',
      },
    ],
    bugs: [
      {
        id: 'Dynamic',
        before: '    Base b = new Reverse();',
        after: '    Base b = new Base();',
        kind: 'logical',
      },
      {
        id: 'Override',
        before: 'class Reverse extends Base {\n  void act() {\n    this.t.前に進む();',
        after: 'class Reverse extends Base {\n  void act() {\n    this.t.後に戻る();',
        kind: 'logical',
      },
      {
        id: 'BaseTurn',
        before: '  void act() {\n    this.t.右を向く();',
        after: '  void act() {\n    this.t.左を向く();',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII5SuperSuffix',
    title: '親の動作の後で一歩戻る',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Base a = new Returner();\n    a.act();\n    a.t.左を向く();\n    a.act();\n    a.t.前に進む();\n  }\n}\nclass Base {\n  Turtle t;\n  Base() {\n    this.t = new Turtle(2, 2);\n  }\n  void act() {\n    this.t.前に進む();\n    this.t.右を向く();\n    this.t.前に進む();\n  }\n}\nclass Returner extends Base {\n  void act() {\n    super.act();\n    this.t.後に戻る();\n  }\n}',
    blanks: [
      {
        id: 'Dispatch',
        before: '    Base a = new Returner();',
        after: '    Base a = new @[Returner]@();',
      },
      {
        id: 'Suffix',
        before: '    this.t.後に戻る();',
        after: '    this.t.@[後に戻る]@();',
      },
      {
        id: 'ParentTurn',
        before: '    this.t.右を向く();',
        after: '    this.t.@[右を向く]@();',
      },
    ],
    bugs: [
      {
        id: 'Dispatch',
        before: '    Base a = new Returner();',
        after: '    Base a = new Base();',
        kind: 'logical',
      },
      {
        id: 'Suffix',
        before: '    this.t.後に戻る();',
        after: '    this.t.左を向く();',
        kind: 'logical',
      },
      {
        id: 'ParentTurn',
        before: '    this.t.右を向く();',
        after: '    this.t.左を向く();',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII5ConstructorTransform',
    title: '親へ渡す値を子で変える',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Shifted a = new Shifted(1);\n    a.act();\n    a.act();\n    a.t.左を向く();\n    a.act();\n  }\n}\nclass Base {\n  Turtle t;\n  int mode;\n  Base(int value) {\n    this.t = new Turtle(2, 2);\n    this.mode = value;\n  }\n  void act() {\n    if (this.mode == 2) {\n      this.t.右を向く();\n    }\n    this.t.前に進む();\n    this.mode--;\n  }\n}\nclass Shifted extends Base {\n  Shifted(int value) {\n    super(value + 1);\n    this.mode++;\n  }\n}',
    blanks: [
      {
        id: 'SuperArgument',
        before: '    super(value + 1);',
        after: '    super(value @[+ 1]@);',
      },
      {
        id: 'ChildUpdate',
        before: '    this.mode++;',
        after: '    this.mode@[++]@;',
      },
      {
        id: 'InheritedGuard',
        before: '    if (this.mode == 2) {',
        after: '    if (this.mode == @[2]@) {',
      },
    ],
    bugs: [
      {
        id: 'SuperArgument',
        before: '    super(value + 1);',
        after: '    super(value + 0);',
        kind: 'logical',
      },
      {
        id: 'ChildUpdate',
        before: '    this.mode++;',
        after: '    this.mode--;',
        kind: 'logical',
      },
      {
        id: 'InheritedGuard',
        before: '    if (this.mode == 2) {',
        after: '    if (this.mode == 1) {',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII5TemplateDispatch',
    title: '親の組み合わせ動作から子を呼ぶ',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Base a = new Alternating();\n    a.pair();\n    a.pair();\n  }\n}\nclass Base {\n  Turtle t;\n  int count;\n  Base() {\n    this.t = new Turtle(2, 2);\n    this.count = 0;\n  }\n  void unit() {\n    this.t.前に進む();\n  }\n  void pair() {\n    this.unit();\n    this.unit();\n  }\n}\nclass Alternating extends Base {\n  void unit() {\n    this.count++;\n    if (this.count % 2 == 0) {\n      this.t.右を向く();\n    }\n    this.t.前に進む();\n  }\n}',
    blanks: [
      {
        id: 'Dispatch',
        before: '    Base a = new Alternating();',
        after: '    Base a = new @[Alternating]@();',
      },
      {
        id: 'Parity',
        before: '    if (this.count % 2 == 0) {',
        after: '    if (this.count % 2 == @[0]@) {',
      },
      {
        id: 'Update',
        before: '    this.count++;',
        after: '    this.count@[++]@;',
      },
    ],
    bugs: [
      {
        id: 'Dispatch',
        before: '    Base a = new Alternating();',
        after: '    Base a = new Base();',
        kind: 'logical',
      },
      {
        id: 'Parity',
        before: '    if (this.count % 2 == 0) {',
        after: '    if (this.count % 2 == 1) {',
        kind: 'logical',
      },
      {
        id: 'Update',
        before: '    this.count++;',
        after: '    this.count += 0;',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII5ReboundBase',
    title: '同じ親型の名前で異なる子を呼ぶ',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Left a = new Left();\n    Right b = new Right();\n    Base selected = a;\n    selected.act();\n    selected = b;\n    selected.act();\n    selected = a;\n    selected.act();\n    b.act();\n  }\n}\nclass Base {\n  Turtle t;\n  Base() {\n    this.t = new Turtle(2, 2);\n  }\n  void act() {\n    this.t.前に進む();\n  }\n}\nclass Left extends Base {\n  void act() {\n    this.t.左を向く();\n    this.t.前に進む();\n  }\n}\nclass Right extends Base {\n  void act() {\n    this.t.前に進む();\n    this.t.右を向く();\n  }\n}',
    blanks: [
      {
        id: 'Rebind',
        before: '    selected = b;',
        after: '    selected = @[b]@;',
      },
      {
        id: 'Left',
        before: '    this.t.左を向く();',
        after: '    this.t.@[左を向く]@();',
      },
      {
        id: 'Right',
        before: 'class Right extends Base {\n  void act() {\n    this.t.前に進む();',
        after: 'class Right extends Base {\n  void act() {\n    this.t.@[前に進む]@();',
      },
    ],
    bugs: [
      {
        id: 'Rebind',
        before: '    selected = b;',
        after: '    selected = a;',
        kind: 'logical',
      },
      {
        id: 'Left',
        before: '    this.t.左を向く();',
        after: '    this.t.右を向く();',
        kind: 'logical',
      },
      {
        id: 'Right',
        before: 'class Right extends Base {\n  void act() {\n    this.t.前に進む();',
        after: 'class Right extends Base {\n  void act() {\n    this.t.後に戻る();',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII5ArrayDispatch',
    title: '配列から選んだ子の動作',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Base a = new Corner();\n    Base b = new Retreat();\n    Base[] choices = {b, a};\n    Base first = choices[0];\n    Base second = choices[1];\n    first.act();\n    second.act();\n    first.act();\n  }\n}\nclass Base {\n  Turtle t;\n  Base() {\n    this.t = new Turtle(3, 3);\n  }\n  void act() {\n    this.t.前に進む();\n  }\n}\nclass Corner extends Base {\n  void act() {\n    this.t.右を向く();\n    this.t.前に進む();\n    this.t.左を向く();\n  }\n}\nclass Retreat extends Base {\n  void act() {\n    this.t.後に戻る();\n    this.t.左を向く();\n  }\n}',
    blanks: [
      {
        id: 'Array',
        before: '    Base[] choices = {b, a};',
        after: '    Base[] choices = {@[b, a]@};',
      },
      {
        id: 'Selected',
        before: '    Base second = choices[1];',
        after: '    Base second = choices[@[1]@];',
      },
      {
        id: 'Retreat',
        before: '    this.t.後に戻る();',
        after: '    this.t.@[後に戻る]@();',
      },
    ],
    bugs: [
      {
        id: 'Array',
        before: '    Base[] choices = {b, a};',
        after: '    Base[] choices = {a, b};',
        kind: 'logical',
      },
      {
        id: 'Selected',
        before: '    Base second = choices[1];',
        after: '    Base second = choices[0];',
        kind: 'logical',
      },
      {
        id: 'Retreat',
        before: '    this.t.後に戻る();',
        after: '    this.t.前に進む();',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII5MixedHelpers',
    title: '継承する補助動作と上書きする補助動作',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Base a = new Changed();\n    a.draw();\n    a.draw();\n    a.t.右を向く();\n  }\n}\nclass Base {\n  Turtle t;\n  Base() {\n    this.t = new Turtle(2, 2);\n  }\n  void first() {\n    this.t.前に進む();\n    this.t.右を向く();\n  }\n  void second() {\n    this.t.前に進む();\n  }\n  void draw() {\n    this.first();\n    this.second();\n  }\n}\nclass Changed extends Base {\n  void second() {\n    this.t.左を向く();\n    this.t.前に進む();\n  }\n}',
    blanks: [
      {
        id: 'Inherited',
        before: '    this.t.右を向く();\n  }\n  void second() {',
        after: '    this.t.@[右を向く]@();\n  }\n  void second() {',
      },
      {
        id: 'Override',
        before: '    Base a = new Changed();',
        after: '    Base a = new @[Changed]@();',
      },
      {
        id: 'Child',
        before: '    this.t.左を向く();',
        after: '    this.t.@[左を向く]@();',
      },
    ],
    bugs: [
      {
        id: 'Inherited',
        before: '    this.t.右を向く();\n  }\n  void second() {',
        after: '    this.t.左を向く();\n  }\n  void second() {',
        kind: 'logical',
      },
      {
        id: 'Override',
        before: '    Base a = new Changed();',
        after: '    Base a = new Base();',
        kind: 'logical',
      },
      {
        id: 'Child',
        before: '    this.t.左を向く();',
        after: '    this.t.右を向く();',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII5SuperChain',
    title: '三段階のsuper呼び出し',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Base a = new Last();\n    a.act();\n    a.t.右を向く();\n    a.act();\n    a.t.後に戻る();\n  }\n}\nclass Base {\n  Turtle t;\n  Base() {\n    this.t = new Turtle(2, 2);\n  }\n  void act() {\n    this.t.前に進む();\n    this.t.右を向く();\n  }\n}\nclass Middle extends Base {\n  void act() {\n    super.act();\n    this.t.前に進む();\n  }\n}\nclass Last extends Middle {\n  void act() {\n    super.act();\n    this.t.左を向く();\n  }\n}',
    blanks: [
      {
        id: 'Chain',
        before: '    Base a = new Last();',
        after: '    Base a = new @[Last]@();',
      },
      {
        id: 'Last',
        before: '    this.t.左を向く();',
        after: '    this.t.@[左を向く]@();',
      },
      {
        id: 'Middle',
        before: 'class Middle extends Base {\n  void act() {\n    super.act();\n    this.t.前に進む();',
        after: 'class Middle extends Base {\n  void act() {\n    super.act();\n    this.t.@[前に進む]@();',
      },
    ],
    bugs: [
      {
        id: 'Chain',
        before: '    Base a = new Last();',
        after: '    Base a = new Middle();',
        kind: 'logical',
      },
      {
        id: 'Last',
        before: '    this.t.左を向く();',
        after: '    this.t.右を向く();',
        kind: 'logical',
      },
      {
        id: 'Middle',
        before: 'class Middle extends Base {\n  void act() {\n    super.act();\n    this.t.前に進む();',
        after: 'class Middle extends Base {\n  void act() {\n    super.act();\n    this.t.後に戻る();',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII5StateOverride',
    title: '状態によって親の動作を選ぶ',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Base a = new Alternating();\n    a.act();\n    a.act();\n    a.act();\n    a.act();\n  }\n}\nclass Base {\n  Turtle t;\n  int count;\n  Base() {\n    this.t = new Turtle(2, 2);\n    this.count = 0;\n  }\n  void act() {\n    this.t.前に進む();\n  }\n}\nclass Alternating extends Base {\n  void act() {\n    this.count++;\n    if (this.count % 2 == 1) {\n      super.act();\n    } else {\n      this.t.右を向く();\n      this.t.前に進む();\n    }\n  }\n}',
    blanks: [
      {
        id: 'Parity',
        before: '    if (this.count % 2 == 1) {',
        after: '    if (this.count % 2 == @[1]@) {',
      },
      {
        id: 'Override',
        before: '    Base a = new Alternating();',
        after: '    Base a = new @[Alternating]@();',
      },
      {
        id: 'ChildTurn',
        before: '      this.t.右を向く();',
        after: '      this.t.@[右を向く]@();',
      },
    ],
    bugs: [
      {
        id: 'Parity',
        before: '    if (this.count % 2 == 1) {',
        after: '    if (this.count % 2 == 0) {',
        kind: 'logical',
      },
      {
        id: 'Override',
        before: '    Base a = new Alternating();',
        after: '    Base a = new Base();',
        kind: 'logical',
      },
      {
        id: 'ChildTurn',
        before: '      this.t.右を向く();',
        after: '      this.t.左を向く();',
        kind: 'logical',
      },
    ],
  },
];
