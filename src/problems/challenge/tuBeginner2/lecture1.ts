import type { ChallengeBase } from '../types';

export const lecture1: ChallengeBase[] = [
  {
    id: 'challengeII1SharedHeading',
    title: '同じ亀を指す二つの名前',
    courseId: 'tuBeginner2',
    lectureIndex: 0,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Turtle first = new Turtle(2, 2);\n    Turtle alias = first;\n    Turtle other = new Turtle(4, 2, "R");\n    first.前に進む();\n    alias.右を向く();\n    first.前に進む();\n    other.左を向く();\n    other.前に進む();\n    alias.後に戻る();\n    first.左を向く();\n    alias.前に進む();\n    other.後に戻る();\n  }\n}',
    blanks: [
      {
        id: 'Alias',
        before: '    Turtle alias = first;',
        after: '    Turtle alias = @[first]@;',
      },
      {
        id: 'Turn',
        before: '    alias.右を向く();',
        after: '    alias.@[右を向く]@();',
      },
      {
        id: 'Return',
        before: '    alias.後に戻る();',
        after: '    alias.@[後に戻る]@();',
      },
    ],
    bugs: [
      {
        id: 'Alias',
        before: '    Turtle alias = first;',
        after: '    Turtle alias = new Turtle(2, 2, "B");',
        kind: 'logical',
      },
      {
        id: 'Turn',
        before: '    alias.右を向く();',
        after: '    alias.左を向く();',
        kind: 'logical',
      },
      {
        id: 'Return',
        before: '    alias.後に戻る();',
        after: '    alias.前に進む();',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII1SwapHandles',
    title: '名前を交換した後の進路',
    courseId: 'tuBeginner2',
    lectureIndex: 0,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Turtle left = new Turtle(2, 2);\n    Turtle right = new Turtle(4, 2, "R");\n    left.右を向く();\n    right.左を向く();\n    Turtle saved = left;\n    left = right;\n    right = saved;\n    left.前に進む();\n    right.後に戻る();\n    left.右を向く();\n    right.左を向く();\n    left.前に進む();\n    right.前に進む();\n  }\n}',
    blanks: [
      {
        id: 'Saved',
        before: '    Turtle saved = left;',
        after: '    Turtle saved = @[left]@;',
      },
      {
        id: 'Assign',
        before: '    left = right;',
        after: '    left = @[right]@;',
      },
      {
        id: 'Motion',
        before: '    right.後に戻る();',
        after: '    right.@[後に戻る]@();',
      },
    ],
    bugs: [
      {
        id: 'Saved',
        before: '    Turtle saved = left;',
        after: '    Turtle saved = right;',
        kind: 'logical',
      },
      {
        id: 'Assign',
        before: '    left = right;',
        after: '    left = saved;',
        kind: 'logical',
      },
      {
        id: 'Motion',
        before: '    right.後に戻る();',
        after: '    right.前に進む();',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII1RowAlias',
    title: '配列の中の亀と別名',
    courseId: 'tuBeginner2',
    lectureIndex: 0,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Turtle a = new Turtle(2, 2);\n    Turtle b = new Turtle(4, 2, "B");\n    Turtle[] pair = {a, b};\n    Turtle selected = pair[1];\n    selected.左を向く();\n    pair[1].前に進む();\n    pair[0].前に進む();\n    selected.右を向く();\n    pair[1].前に進む();\n    a.右を向く();\n    a.前に進む();\n    b.後に戻る();\n  }\n}',
    blanks: [
      {
        id: 'Slot',
        before: '    Turtle selected = pair[1];',
        after: '    Turtle selected = pair[@[1]@];',
      },
      {
        id: 'Turn',
        before: '    selected.左を向く();',
        after: '    selected.@[左を向く]@();',
      },
      {
        id: 'ArrayCall',
        before: '    pair[0].前に進む();',
        after: '    pair[@[0]@].前に進む();',
      },
    ],
    bugs: [
      {
        id: 'Slot',
        before: '    Turtle selected = pair[1];',
        after: '    Turtle selected = pair[0];',
        kind: 'logical',
      },
      {
        id: 'Turn',
        before: '    selected.左を向く();',
        after: '    selected.右を向く();',
        kind: 'logical',
      },
      {
        id: 'ArrayCall',
        before: '    pair[0].前に進む();',
        after: '    pair[1].前に進む();',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII1ReplaceSlot',
    title: '入れ替えた要素と残った別名',
    courseId: 'tuBeginner2',
    lectureIndex: 0,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Turtle old = new Turtle(2, 2);\n    Turtle replacement = new Turtle(4, 2, "R");\n    Turtle[] slots = {old, replacement};\n    Turtle held = slots[0];\n    slots[0] = replacement;\n    held.前に進む();\n    slots[0].左を向く();\n    slots[0].前に進む();\n    held.右を向く();\n    old.前に進む();\n    replacement.右を向く();\n    slots[1].前に進む();\n  }\n}',
    blanks: [
      {
        id: 'Held',
        before: '    Turtle held = slots[0];',
        after: '    Turtle held = slots[@[0]@];',
      },
      {
        id: 'Replacement',
        before: '    slots[0] = replacement;',
        after: '    slots[0] = @[replacement]@;',
      },
      {
        id: 'OldMotion',
        before: '    old.前に進む();',
        after: '    old.@[前に進む]@();',
      },
    ],
    bugs: [
      {
        id: 'Held',
        before: '    Turtle held = slots[0];',
        after: '    Turtle held = slots[1];',
        kind: 'logical',
      },
      {
        id: 'Replacement',
        before: '    slots[0] = replacement;',
        after: '    slots[0] = old;',
        kind: 'logical',
      },
      {
        id: 'OldMotion',
        before: '    old.前に進む();',
        after: '    old.後に戻る();',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII1DetachAlias',
    title: '別名の付け替え',
    courseId: 'tuBeginner2',
    lectureIndex: 0,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Turtle red = new Turtle(2, 2, "R");\n    Turtle blue = new Turtle(4, 2, "B");\n    Turtle active = red;\n    active.前に進む();\n    active.右を向く();\n    active = blue;\n    active.左を向く();\n    active.前に進む();\n    red.後に戻る();\n    blue.右を向く();\n    active.前に進む();\n    red.左を向く();\n  }\n}',
    blanks: [
      {
        id: 'Initial',
        before: '    Turtle active = red;',
        after: '    Turtle active = @[red]@;',
      },
      {
        id: 'Rebind',
        before: '    active = blue;',
        after: '    active = @[blue]@;',
      },
      {
        id: 'OldHeading',
        before: '    red.左を向く();',
        after: '    red.@[左を向く]@();',
      },
    ],
    bugs: [
      {
        id: 'Initial',
        before: '    Turtle active = red;',
        after: '    Turtle active = blue;',
        kind: 'logical',
      },
      {
        id: 'Rebind',
        before: '    active = blue;',
        after: '    active = red;',
        kind: 'logical',
      },
      {
        id: 'OldHeading',
        before: '    red.左を向く();',
        after: '    red.右を向く();',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII1BlockedLane',
    title: '隣の亀が動くと通れる',
    courseId: 'tuBeginner2',
    lectureIndex: 0,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Turtle walker = new Turtle(2, 2);\n    Turtle blocker = new Turtle(2, 3, "R");\n    if (walker.前に進めるか()) {\n      walker.前に進む();\n    }\n    blocker.右を向く();\n    blocker.前に進む();\n    if (walker.前に進めるか()) {\n      walker.前に進む();\n    }\n    walker.左を向く();\n    walker.前に進む();\n    blocker.左を向く();\n    blocker.前に進む();\n    walker.右を向く();\n    walker.前に進む();\n  }\n}',
    blanks: [
      {
        id: 'Gate',
        before: '    if (walker.前に進めるか()) {\n      walker.前に進む();\n    }\n    blocker.右を向く();',
        after: '    if (@[walker.前に進めるか()]@) {\n      walker.前に進む();\n    }\n    blocker.右を向く();',
      },
      {
        id: 'Release',
        before: '    blocker.右を向く();',
        after: '    blocker.@[右を向く]@();',
      },
      {
        id: 'Finish',
        before: '    walker.右を向く();',
        after: '    walker.@[右を向く]@();',
      },
    ],
    bugs: [
      {
        id: 'Gate',
        before: '    if (walker.前に進めるか()) {\n      walker.前に進む();\n    }\n    blocker.右を向く();',
        after: '    if (!walker.前に進めるか()) {\n      walker.前に進む();\n    }\n    blocker.右を向く();',
        kind: 'logical',
      },
      {
        id: 'Release',
        before: '    blocker.右を向く();',
        after: '    blocker.左を向く();',
        kind: 'logical',
      },
      {
        id: 'Finish',
        before: '    walker.右を向く();',
        after: '    walker.左を向く();',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII1RepeatedEntry',
    title: '同じ亀が二つの要素にある',
    courseId: 'tuBeginner2',
    lectureIndex: 0,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Turtle shared = new Turtle(2, 2);\n    Turtle separate = new Turtle(4, 2, "R");\n    Turtle[] turns = {shared, shared, separate};\n    turns[0].右を向く();\n    turns[1].右を向く();\n    shared.前に進む();\n    turns[2].左を向く();\n    separate.前に進む();\n    turns[0].左を向く();\n    shared.前に進む();\n    separate.右を向く();\n    separate.前に進む();\n  }\n}',
    blanks: [
      {
        id: 'SharedEntry',
        before: '    Turtle[] turns = {shared, shared, separate};',
        after: '    Turtle[] turns = @[{shared, shared, separate}]@;',
      },
      {
        id: 'SecondTurn',
        before: '    turns[1].右を向く();',
        after: '    turns[1].@[右を向く]@();',
      },
      {
        id: 'SeparateMotion',
        before: '    separate.前に進む();\n    turns[0].左を向く();',
        after: '    separate.@[前に進む]@();\n    turns[0].左を向く();',
      },
    ],
    bugs: [
      {
        id: 'SharedEntry',
        before: '    Turtle[] turns = {shared, shared, separate};',
        after: '    Turtle[] turns = {shared, separate, separate};',
        kind: 'logical',
      },
      {
        id: 'SecondTurn',
        before: '    turns[1].右を向く();',
        after: '    turns[1].左を向く();',
        kind: 'logical',
      },
      {
        id: 'SeparateMotion',
        before: '    separate.前に進む();\n    turns[0].左を向く();',
        after: '    separate.後に戻る();\n    turns[0].左を向く();',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII1PassReference',
    title: 'メソッドへ渡した亀',
    courseId: 'tuBeginner2',
    lectureIndex: 0,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Turtle a = new Turtle(2, 2);\n    Turtle b = new Turtle(4, 2, "B");\n    draw(a);\n    b.左を向く();\n    draw(b);\n    a.後に戻る();\n    b.右を向く();\n    a.左を向く();\n    a.前に進む();\n  }\n  static void draw(Turtle t) {\n    t.前に進む();\n    t.右を向く();\n    t.前に進む();\n  }\n}',
    blanks: [
      {
        id: 'First',
        before: '    draw(a);',
        after: '    draw@[(a)]@;',
      },
      {
        id: 'Second',
        before: '    draw(b);',
        after: '    draw@[(b)]@;',
      },
      {
        id: 'Later',
        before: '    a.後に戻る();',
        after: '    a.@[後に戻る]@();',
      },
    ],
    bugs: [
      {
        id: 'First',
        before: '    draw(a);',
        after: '    draw(b);',
        kind: 'logical',
      },
      {
        id: 'Second',
        before: '    draw(b);',
        after: '    draw(a);',
        kind: 'logical',
      },
      {
        id: 'Later',
        before: '    a.後に戻る();',
        after: '    a.前に進む();',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII1KeepOriginal',
    title: '元の参照を残して新しい亀へ',
    courseId: 'tuBeginner2',
    lectureIndex: 0,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Turtle current = new Turtle(2, 2);\n    Turtle original = current;\n    current.前に進む();\n    current = new Turtle(4, 2, "R");\n    current.左を向く();\n    current.前に進む();\n    original.右を向く();\n    original.前に進む();\n    current.右を向く();\n    current.前に進む();\n    original.左を向く();\n    original.前に進む();\n  }\n}',
    blanks: [
      {
        id: 'Keep',
        before: '    Turtle original = current;',
        after: '    Turtle original = @[current]@;',
      },
      {
        id: 'NewHeading',
        before: '    current.左を向く();',
        after: '    current.@[左を向く]@();',
      },
      {
        id: 'OldHeading',
        before: '    original.右を向く();',
        after: '    original.@[右を向く]@();',
      },
    ],
    bugs: [
      {
        id: 'Keep',
        before: '    Turtle original = current;',
        after: '    Turtle original = new Turtle(2, 2, "B");',
        kind: 'logical',
      },
      {
        id: 'NewHeading',
        before: '    current.左を向く();',
        after: '    current.右を向く();',
        kind: 'logical',
      },
      {
        id: 'OldHeading',
        before: '    original.右を向く();',
        after: '    original.左を向く();',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII1ParameterRebind',
    title: '引数の付け替えは呼び出し元へ戻らない',
    courseId: 'tuBeginner2',
    lectureIndex: 0,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Turtle a = new Turtle(2, 2);\n    Turtle b = new Turtle(4, 2, "B");\n    shift(a, b);\n    a.前に進む();\n    b.後に戻る();\n    a.右を向く();\n    a.前に進む();\n    b.左を向く();\n    b.前に進む();\n  }\n  static void shift(Turtle selected, Turtle other) {\n    selected.右を向く();\n    selected = other;\n    selected.左を向く();\n    selected.前に進む();\n  }\n}',
    blanks: [
      {
        id: 'Arguments',
        before: '    shift(a, b);',
        after: '    shift(@[a, b]@);',
      },
      {
        id: 'LocalBinding',
        before: '    selected = other;',
        after: '    selected = @[other]@;',
      },
      {
        id: 'LocalTurn',
        before: '    selected.左を向く();',
        after: '    selected.@[左を向く]@();',
      },
    ],
    bugs: [
      {
        id: 'Arguments',
        before: '    shift(a, b);',
        after: '    shift(b, a);',
        kind: 'logical',
      },
      {
        id: 'LocalBinding',
        before: '    selected = other;',
        after: '    selected = selected;',
        kind: 'logical',
      },
      {
        id: 'LocalTurn',
        before: '    selected.左を向く();',
        after: '    selected.右を向く();',
        kind: 'logical',
      },
    ],
  },
];
