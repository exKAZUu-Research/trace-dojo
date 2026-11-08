import type { CorrectProblem } from '../types';

export const lecture1: CorrectProblem[] = [
  {
    id: 'challengeII1SharedHeading',
    title: '同じ亀を指す二つの名前',
    courseId: 'tuBeginner2',
    lectureIndex: 0,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Turtle first = new Turtle(2, 2);\n    Turtle alias = first;\n    Turtle other = new Turtle(4, 2, "R");\n    first.前に進む();\n    alias.右を向く();\n    first.前に進む();\n    other.左を向く();\n    other.前に進む();\n    alias.後に戻る();\n    first.左を向く();\n    alias.前に進む();\n    other.後に戻る();\n  }\n}',
  },
  {
    id: 'challengeII1SwapHandles',
    title: '名前を交換した後の進路',
    courseId: 'tuBeginner2',
    lectureIndex: 0,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Turtle left = new Turtle(2, 2);\n    Turtle right = new Turtle(4, 2, "R");\n    left.右を向く();\n    right.左を向く();\n    Turtle saved = left;\n    left = right;\n    right = saved;\n    left.前に進む();\n    right.後に戻る();\n    left.右を向く();\n    right.左を向く();\n    left.前に進む();\n    right.前に進む();\n  }\n}',
  },
  {
    id: 'challengeII1RowAlias',
    title: '配列の中の亀と別名',
    courseId: 'tuBeginner2',
    lectureIndex: 0,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Turtle a = new Turtle(2, 2);\n    Turtle b = new Turtle(4, 2, "B");\n    Turtle[] pair = {a, b};\n    Turtle selected = pair[1];\n    selected.左を向く();\n    pair[1].前に進む();\n    pair[0].前に進む();\n    selected.右を向く();\n    pair[1].前に進む();\n    a.右を向く();\n    a.前に進む();\n    b.後に戻る();\n  }\n}',
  },
  {
    id: 'challengeII1ReplaceSlot',
    title: '入れ替えた要素と残った別名',
    courseId: 'tuBeginner2',
    lectureIndex: 0,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Turtle old = new Turtle(2, 2);\n    Turtle replacement = new Turtle(4, 2, "R");\n    Turtle[] slots = {old, replacement};\n    Turtle held = slots[0];\n    slots[0] = replacement;\n    held.前に進む();\n    slots[0].左を向く();\n    slots[0].前に進む();\n    held.右を向く();\n    old.前に進む();\n    replacement.右を向く();\n    slots[1].前に進む();\n  }\n}',
  },
  {
    id: 'challengeII1DetachAlias',
    title: '別名の付け替え',
    courseId: 'tuBeginner2',
    lectureIndex: 0,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Turtle red = new Turtle(2, 2, "R");\n    Turtle blue = new Turtle(4, 2, "B");\n    Turtle active = red;\n    active.前に進む();\n    active.右を向く();\n    active = blue;\n    active.左を向く();\n    active.前に進む();\n    red.後に戻る();\n    blue.右を向く();\n    active.前に進む();\n    red.左を向く();\n  }\n}',
  },
  {
    id: 'challengeII1BlockedLane',
    title: '隣の亀が動くと通れる',
    courseId: 'tuBeginner2',
    lectureIndex: 0,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Turtle walker = new Turtle(2, 2);\n    Turtle blocker = new Turtle(2, 3, "R");\n    if (walker.前に進めるか()) {\n      walker.前に進む();\n    }\n    blocker.右を向く();\n    blocker.前に進む();\n    if (walker.前に進めるか()) {\n      walker.前に進む();\n    }\n    walker.左を向く();\n    walker.前に進む();\n    blocker.左を向く();\n    blocker.前に進む();\n    walker.右を向く();\n    walker.前に進む();\n  }\n}',
  },
  {
    id: 'challengeII1RepeatedEntry',
    title: '同じ亀が二つの要素にある',
    courseId: 'tuBeginner2',
    lectureIndex: 0,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Turtle shared = new Turtle(2, 2);\n    Turtle separate = new Turtle(4, 2, "R");\n    Turtle[] turns = {shared, shared, separate};\n    turns[0].右を向く();\n    turns[1].右を向く();\n    shared.前に進む();\n    turns[2].左を向く();\n    separate.前に進む();\n    turns[0].左を向く();\n    shared.前に進む();\n    separate.右を向く();\n    separate.前に進む();\n  }\n}',
  },
  {
    id: 'challengeII1PassReference',
    title: 'メソッドへ渡した亀',
    courseId: 'tuBeginner2',
    lectureIndex: 0,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Turtle a = new Turtle(2, 2);\n    Turtle b = new Turtle(4, 2, "B");\n    draw(a);\n    b.左を向く();\n    draw(b);\n    a.後に戻る();\n    b.右を向く();\n    a.左を向く();\n    a.前に進む();\n  }\n  static void draw(Turtle t) {\n    t.前に進む();\n    t.右を向く();\n    t.前に進む();\n  }\n}',
  },
  {
    id: 'challengeII1KeepOriginal',
    title: '元の参照を残して新しい亀へ',
    courseId: 'tuBeginner2',
    lectureIndex: 0,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Turtle current = new Turtle(2, 2);\n    Turtle original = current;\n    current.前に進む();\n    current = new Turtle(4, 2, "R");\n    current.左を向く();\n    current.前に進む();\n    original.右を向く();\n    original.前に進む();\n    current.右を向く();\n    current.前に進む();\n    original.左を向く();\n    original.前に進む();\n  }\n}',
  },
  {
    id: 'challengeII1ParameterRebind',
    title: '引数の付け替えは呼び出し元へ戻らない',
    courseId: 'tuBeginner2',
    lectureIndex: 0,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Turtle a = new Turtle(2, 2);\n    Turtle b = new Turtle(4, 2, "B");\n    shift(a, b);\n    a.前に進む();\n    b.後に戻る();\n    a.右を向く();\n    a.前に進む();\n    b.左を向く();\n    b.前に進む();\n  }\n  static void shift(Turtle selected, Turtle other) {\n    selected.右を向く();\n    selected = other;\n    selected.左を向く();\n    selected.前に進む();\n  }\n}',
  },
];
