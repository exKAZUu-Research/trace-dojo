import type { ChallengeBase } from '../types';

export const lecture1: ChallengeBase[] = [
  {
    id: 'challengeII1SharedHeading',
    title: '同じ亀を指す二つの名前',
    courseId: 'tuBeginner2',
    lectureIndex: 0,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Turtle first = new Turtle(2, 2); // step\n    Turtle alias = first; // step\n    Turtle other = new Turtle(4, 2, "R"); // step\n    first.前に進む(); // step\n    alias.右を向く(); // step\n    first.前に進む(); // step\n    other.左を向く(); // step\n    other.前に進む(); // step\n    alias.後に戻る(); // step\n    first.左を向く(); // step\n    alias.前に進む(); // step\n    other.後に戻る(); // step\n  }\n}',
    instrumented:
      "function main() {\nlet first = new Turtle(2, 2); registerDisplayRef('first', () => first); // step\nlet alias = first; registerDisplayRef('alias', () => alias); // step\nlet other = new Turtle(4, 2, \"R\"); registerDisplayRef('other', () => other); // step\nfirst.前に進む(); // step\nalias.右を向く(); // step\nfirst.前に進む(); // step\nother.左を向く(); // step\nother.前に進む(); // step\nalias.後に戻る(); // step\nfirst.左を向く(); // step\nalias.前に進む(); // step\nother.後に戻る(); // step\n}\nmain();",
    blanks: [
      {
        id: 'Alias',
        before: '    Turtle alias = first; // step',
        after: '    Turtle alias = @[first]@; // step',
      },
      {
        id: 'Turn',
        before: '    alias.右を向く(); // step',
        after: '    alias.@[右を向く]@(); // step',
      },
      {
        id: 'Return',
        before: '    alias.後に戻る(); // step',
        after: '    alias.@[後に戻る]@(); // step',
      },
    ],
    bugs: [
      {
        id: 'Alias',
        before: '    Turtle alias = first; // step',
        after: '    Turtle alias = new Turtle(2, 2, "B"); // step',
        kind: 'logical',
      },
      {
        id: 'Turn',
        before: '    alias.右を向く(); // step',
        after: '    alias.左を向く(); // step',
        kind: 'logical',
      },
      {
        id: 'Return',
        before: '    alias.後に戻る(); // step',
        after: '    alias.前に進む(); // step',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII1SwapHandles',
    title: '名前を交換した後の進路',
    courseId: 'tuBeginner2',
    lectureIndex: 0,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Turtle left = new Turtle(2, 2); // step\n    Turtle right = new Turtle(4, 2, "R"); // step\n    left.右を向く(); // step\n    right.左を向く(); // step\n    Turtle saved = left; // step\n    left = right; // step\n    right = saved; // step\n    left.前に進む(); // step\n    right.後に戻る(); // step\n    left.右を向く(); // step\n    right.左を向く(); // step\n    left.前に進む(); // step\n    right.前に進む(); // step\n  }\n}',
    instrumented:
      "function main() {\nlet left = new Turtle(2, 2); registerDisplayRef('left', () => left); // step\nlet right = new Turtle(4, 2, \"R\"); registerDisplayRef('right', () => right); // step\nleft.右を向く(); // step\nright.左を向く(); // step\nlet saved = left; registerDisplayRef('saved', () => saved); // step\nleft = right; // step\nright = saved; // step\nleft.前に進む(); // step\nright.後に戻る(); // step\nleft.右を向く(); // step\nright.左を向く(); // step\nleft.前に進む(); // step\nright.前に進む(); // step\n}\nmain();",
    blanks: [
      {
        id: 'Saved',
        before: '    Turtle saved = left; // step',
        after: '    Turtle saved = @[left]@; // step',
      },
      {
        id: 'Assign',
        before: '    left = right; // step',
        after: '    left = @[right]@; // step',
      },
      {
        id: 'Motion',
        before: '    right.後に戻る(); // step',
        after: '    right.@[後に戻る]@(); // step',
      },
    ],
    bugs: [
      {
        id: 'Saved',
        before: '    Turtle saved = left; // step',
        after: '    Turtle saved = right; // step',
        kind: 'logical',
      },
      {
        id: 'Assign',
        before: '    left = right; // step',
        after: '    left = saved; // step',
        kind: 'logical',
      },
      {
        id: 'Motion',
        before: '    right.後に戻る(); // step',
        after: '    right.前に進む(); // step',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII1RowAlias',
    title: '配列の中の亀と別名',
    courseId: 'tuBeginner2',
    lectureIndex: 0,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Turtle a = new Turtle(2, 2); // step\n    Turtle b = new Turtle(4, 2, "B"); // step\n    Turtle[] pair = {a, b}; // step\n    Turtle selected = pair[1]; // step\n    selected.左を向く(); // step\n    pair[1].前に進む(); // step\n    pair[0].前に進む(); // step\n    selected.右を向く(); // step\n    pair[1].前に進む(); // step\n    a.右を向く(); // step\n    a.前に進む(); // step\n    b.後に戻る(); // step\n  }\n}',
    instrumented:
      "function main() {\nlet a = new Turtle(2, 2); registerDisplayRef('a', () => a); // step\nlet b = new Turtle(4, 2, \"B\"); registerDisplayRef('b', () => b); // step\nlet pair = [a, b]; registerDisplayRef('pair', () => pair); // step\nlet selected = pair[1]; registerDisplayRef('selected', () => selected); // step\nselected.左を向く(); // step\npair[1].前に進む(); // step\npair[0].前に進む(); // step\nselected.右を向く(); // step\npair[1].前に進む(); // step\na.右を向く(); // step\na.前に進む(); // step\nb.後に戻る(); // step\n}\nmain();",
    blanks: [
      {
        id: 'Slot',
        before: '    Turtle selected = pair[1]; // step',
        after: '    Turtle selected = pair[@[1]@]; // step',
      },
      {
        id: 'Turn',
        before: '    selected.左を向く(); // step',
        after: '    selected.@[左を向く]@(); // step',
      },
      {
        id: 'ArrayCall',
        before: '    pair[0].前に進む(); // step',
        after: '    pair[@[0]@].前に進む(); // step',
      },
    ],
    bugs: [
      {
        id: 'Slot',
        before: '    Turtle selected = pair[1]; // step',
        after: '    Turtle selected = pair[0]; // step',
        kind: 'logical',
      },
      {
        id: 'Turn',
        before: '    selected.左を向く(); // step',
        after: '    selected.右を向く(); // step',
        kind: 'logical',
      },
      {
        id: 'ArrayCall',
        before: '    pair[0].前に進む(); // step',
        after: '    pair[1].前に進む(); // step',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII1ReplaceSlot',
    title: '入れ替えた要素と残った別名',
    courseId: 'tuBeginner2',
    lectureIndex: 0,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Turtle old = new Turtle(2, 2); // step\n    Turtle replacement = new Turtle(4, 2, "R"); // step\n    Turtle[] slots = {old, replacement}; // step\n    Turtle held = slots[0]; // step\n    slots[0] = replacement; // step\n    held.前に進む(); // step\n    slots[0].左を向く(); // step\n    slots[0].前に進む(); // step\n    held.右を向く(); // step\n    old.前に進む(); // step\n    replacement.右を向く(); // step\n    slots[1].前に進む(); // step\n  }\n}',
    instrumented:
      "function main() {\nlet old = new Turtle(2, 2); registerDisplayRef('old', () => old); // step\nlet replacement = new Turtle(4, 2, \"R\"); registerDisplayRef('replacement', () => replacement); // step\nlet slots = [old, replacement]; registerDisplayRef('slots', () => slots); // step\nlet held = slots[0]; registerDisplayRef('held', () => held); // step\nslots[0] = replacement; // step\nheld.前に進む(); // step\nslots[0].左を向く(); // step\nslots[0].前に進む(); // step\nheld.右を向く(); // step\nold.前に進む(); // step\nreplacement.右を向く(); // step\nslots[1].前に進む(); // step\n}\nmain();",
    blanks: [
      {
        id: 'Held',
        before: '    Turtle held = slots[0]; // step',
        after: '    Turtle held = slots[@[0]@]; // step',
      },
      {
        id: 'Replacement',
        before: '    slots[0] = replacement; // step',
        after: '    slots[0] = @[replacement]@; // step',
      },
      {
        id: 'OldMotion',
        before: '    old.前に進む(); // step',
        after: '    old.@[前に進む]@(); // step',
      },
    ],
    bugs: [
      {
        id: 'Held',
        before: '    Turtle held = slots[0]; // step',
        after: '    Turtle held = slots[1]; // step',
        kind: 'logical',
      },
      {
        id: 'Replacement',
        before: '    slots[0] = replacement; // step',
        after: '    slots[0] = old; // step',
        kind: 'logical',
      },
      {
        id: 'OldMotion',
        before: '    old.前に進む(); // step',
        after: '    old.後に戻る(); // step',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII1DetachAlias',
    title: '別名の付け替え',
    courseId: 'tuBeginner2',
    lectureIndex: 0,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Turtle red = new Turtle(2, 2, "R"); // step\n    Turtle blue = new Turtle(4, 2, "B"); // step\n    Turtle active = red; // step\n    active.前に進む(); // step\n    active.右を向く(); // step\n    active = blue; // step\n    active.左を向く(); // step\n    active.前に進む(); // step\n    red.後に戻る(); // step\n    blue.右を向く(); // step\n    active.前に進む(); // step\n    red.左を向く(); // step\n  }\n}',
    instrumented:
      "function main() {\nlet red = new Turtle(2, 2, \"R\"); registerDisplayRef('red', () => red); // step\nlet blue = new Turtle(4, 2, \"B\"); registerDisplayRef('blue', () => blue); // step\nlet active = red; registerDisplayRef('active', () => active); // step\nactive.前に進む(); // step\nactive.右を向く(); // step\nactive = blue; // step\nactive.左を向く(); // step\nactive.前に進む(); // step\nred.後に戻る(); // step\nblue.右を向く(); // step\nactive.前に進む(); // step\nred.左を向く(); // step\n}\nmain();",
    blanks: [
      {
        id: 'Initial',
        before: '    Turtle active = red; // step',
        after: '    Turtle active = @[red]@; // step',
      },
      {
        id: 'Rebind',
        before: '    active = blue; // step',
        after: '    active = @[blue]@; // step',
      },
      {
        id: 'OldHeading',
        before: '    red.左を向く(); // step',
        after: '    red.@[左を向く]@(); // step',
      },
    ],
    bugs: [
      {
        id: 'Initial',
        before: '    Turtle active = red; // step',
        after: '    Turtle active = blue; // step',
        kind: 'logical',
      },
      {
        id: 'Rebind',
        before: '    active = blue; // step',
        after: '    active = red; // step',
        kind: 'logical',
      },
      {
        id: 'OldHeading',
        before: '    red.左を向く(); // step',
        after: '    red.右を向く(); // step',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII1BlockedLane',
    title: '隣の亀が動くと通れる',
    courseId: 'tuBeginner2',
    lectureIndex: 0,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Turtle walker = new Turtle(2, 2); // step\n    Turtle blocker = new Turtle(2, 3, "R"); // step\n    if (walker.前に進めるか()) {\n      walker.前に進む(); // step\n    }\n    blocker.右を向く(); // step\n    blocker.前に進む(); // step\n    if (walker.前に進めるか()) {\n      walker.前に進む(); // step\n    }\n    walker.左を向く(); // step\n    walker.前に進む(); // step\n    blocker.左を向く(); // step\n    blocker.前に進む(); // step\n    walker.右を向く(); // step\n    walker.前に進む(); // step\n  }\n}',
    instrumented:
      "function main() {\nlet walker = new Turtle(2, 2); registerDisplayRef('walker', () => walker); // step\nlet blocker = new Turtle(2, 3, \"R\"); registerDisplayRef('blocker', () => blocker); // step\nif (walker.canMoveForward()) {\nwalker.前に進む(); // step\n}\nblocker.右を向く(); // step\nblocker.前に進む(); // step\nif (walker.canMoveForward()) {\nwalker.前に進む(); // step\n}\nwalker.左を向く(); // step\nwalker.前に進む(); // step\nblocker.左を向く(); // step\nblocker.前に進む(); // step\nwalker.右を向く(); // step\nwalker.前に進む(); // step\n}\nmain();",
    blanks: [
      {
        id: 'Gate',
        before:
          '    if (walker.前に進めるか()) {\n      walker.前に進む(); // step\n    }\n    blocker.右を向く(); // step',
        after:
          '    if (@[walker.前に進めるか()]@) {\n      walker.前に進む(); // step\n    }\n    blocker.右を向く(); // step',
      },
      {
        id: 'Release',
        before: '    blocker.右を向く(); // step',
        after: '    blocker.@[右を向く]@(); // step',
      },
      {
        id: 'Finish',
        before: '    walker.右を向く(); // step',
        after: '    walker.@[右を向く]@(); // step',
      },
    ],
    bugs: [
      {
        id: 'Gate',
        before:
          '    if (walker.前に進めるか()) {\n      walker.前に進む(); // step\n    }\n    blocker.右を向く(); // step',
        after:
          '    if (!walker.前に進めるか()) {\n      walker.前に進む(); // step\n    }\n    blocker.右を向く(); // step',
        kind: 'logical',
      },
      {
        id: 'Release',
        before: '    blocker.右を向く(); // step',
        after: '    blocker.左を向く(); // step',
        kind: 'logical',
      },
      {
        id: 'Finish',
        before: '    walker.右を向く(); // step',
        after: '    walker.左を向く(); // step',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII1RepeatedEntry',
    title: '同じ亀が二つの要素にある',
    courseId: 'tuBeginner2',
    lectureIndex: 0,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Turtle shared = new Turtle(2, 2); // step\n    Turtle separate = new Turtle(4, 2, "R"); // step\n    Turtle[] turns = {shared, shared, separate}; // step\n    turns[0].右を向く(); // step\n    turns[1].右を向く(); // step\n    shared.前に進む(); // step\n    turns[2].左を向く(); // step\n    separate.前に進む(); // step\n    turns[0].左を向く(); // step\n    shared.前に進む(); // step\n    separate.右を向く(); // step\n    separate.前に進む(); // step\n  }\n}',
    instrumented:
      "function main() {\nlet shared = new Turtle(2, 2); registerDisplayRef('shared', () => shared); // step\nlet separate = new Turtle(4, 2, \"R\"); registerDisplayRef('separate', () => separate); // step\nlet turns = [shared, shared, separate]; registerDisplayRef('turns', () => turns); // step\nturns[0].右を向く(); // step\nturns[1].右を向く(); // step\nshared.前に進む(); // step\nturns[2].左を向く(); // step\nseparate.前に進む(); // step\nturns[0].左を向く(); // step\nshared.前に進む(); // step\nseparate.右を向く(); // step\nseparate.前に進む(); // step\n}\nmain();",
    blanks: [
      {
        id: 'SharedEntry',
        before: '    Turtle[] turns = {shared, shared, separate}; // step',
        after: '    Turtle[] turns = @[{shared, shared, separate}]@; // step',
      },
      {
        id: 'SecondTurn',
        before: '    turns[1].右を向く(); // step',
        after: '    turns[1].@[右を向く]@(); // step',
      },
      {
        id: 'SeparateMotion',
        before: '    separate.前に進む(); // step\n    turns[0].左を向く(); // step',
        after: '    separate.@[前に進む]@(); // step\n    turns[0].左を向く(); // step',
      },
    ],
    bugs: [
      {
        id: 'SharedEntry',
        before: '    Turtle[] turns = {shared, shared, separate}; // step',
        after: '    Turtle[] turns = {shared, separate, separate}; // step',
        kind: 'logical',
      },
      {
        id: 'SecondTurn',
        before: '    turns[1].右を向く(); // step',
        after: '    turns[1].左を向く(); // step',
        kind: 'logical',
      },
      {
        id: 'SeparateMotion',
        before: '    separate.前に進む(); // step\n    turns[0].左を向く(); // step',
        after: '    separate.後に戻る(); // step\n    turns[0].左を向く(); // step',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII1PassReference',
    title: 'メソッドへ渡した亀',
    courseId: 'tuBeginner2',
    lectureIndex: 0,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Turtle a = new Turtle(2, 2); // step\n    Turtle b = new Turtle(4, 2, "B"); // step\n    draw(a); // caller\n    b.左を向く(); // step\n    draw(b); // caller\n    a.後に戻る(); // step\n    b.右を向く(); // step\n    a.左を向く(); // step\n    a.前に進む(); // step\n  }\n  static void draw(Turtle t) {\n    t.前に進む(); // step\n    t.右を向く(); // step\n    t.前に進む(); // step\n  }\n}',
    instrumented:
      'function main() {\nlet a = new Turtle(2, 2); registerDisplayRef("a", () => a); // step\nlet b = new Turtle(4, 2, "B"); registerDisplayRef("b", () => b); // step\ncall(Corner.draw.bind(Corner), "t")(a);\nb.turnLeft();\ncall(Corner.draw.bind(Corner), "t")(b);\na.backward();\nb.turnRight();\na.turnLeft();\na.forward();\n}\nclass Corner {\nstatic draw(t) {\nt.forward();\nt.turnRight();\nt.forward();\n}\n}\nmain();',
    blanks: [
      {
        id: 'First',
        before: '    draw(a); // caller',
        after: '    draw@[(a)]@; // caller',
      },
      {
        id: 'Second',
        before: '    draw(b); // caller',
        after: '    draw@[(b)]@; // caller',
      },
      {
        id: 'Later',
        before: '    a.後に戻る(); // step',
        after: '    a.@[後に戻る]@(); // step',
      },
    ],
    bugs: [
      {
        id: 'First',
        before: '    draw(a); // caller',
        after: '    draw(b); // caller',
        kind: 'logical',
      },
      {
        id: 'Second',
        before: '    draw(b); // caller',
        after: '    draw(a); // caller',
        kind: 'logical',
      },
      {
        id: 'Later',
        before: '    a.後に戻る(); // step',
        after: '    a.前に進む(); // step',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII1KeepOriginal',
    title: '元の参照を残して新しい亀へ',
    courseId: 'tuBeginner2',
    lectureIndex: 0,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Turtle current = new Turtle(2, 2); // step\n    Turtle original = current; // step\n    current.前に進む(); // step\n    current = new Turtle(4, 2, "R"); // step\n    current.左を向く(); // step\n    current.前に進む(); // step\n    original.右を向く(); // step\n    original.前に進む(); // step\n    current.右を向く(); // step\n    current.前に進む(); // step\n    original.左を向く(); // step\n    original.前に進む(); // step\n  }\n}',
    instrumented:
      "function main() {\nlet current = new Turtle(2, 2); registerDisplayRef('current', () => current); // step\nlet original = current; registerDisplayRef('original', () => original); // step\ncurrent.前に進む(); // step\ncurrent = new Turtle(4, 2, \"R\"); // step\ncurrent.左を向く(); // step\ncurrent.前に進む(); // step\noriginal.右を向く(); // step\noriginal.前に進む(); // step\ncurrent.右を向く(); // step\ncurrent.前に進む(); // step\noriginal.左を向く(); // step\noriginal.前に進む(); // step\n}\nmain();",
    blanks: [
      {
        id: 'Keep',
        before: '    Turtle original = current; // step',
        after: '    Turtle original = @[current]@; // step',
      },
      {
        id: 'NewHeading',
        before: '    current.左を向く(); // step',
        after: '    current.@[左を向く]@(); // step',
      },
      {
        id: 'OldHeading',
        before: '    original.右を向く(); // step',
        after: '    original.@[右を向く]@(); // step',
      },
    ],
    bugs: [
      {
        id: 'Keep',
        before: '    Turtle original = current; // step',
        after: '    Turtle original = new Turtle(2, 2, "B"); // step',
        kind: 'logical',
      },
      {
        id: 'NewHeading',
        before: '    current.左を向く(); // step',
        after: '    current.右を向く(); // step',
        kind: 'logical',
      },
      {
        id: 'OldHeading',
        before: '    original.右を向く(); // step',
        after: '    original.左を向く(); // step',
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII1ParameterRebind',
    title: '引数の付け替えは呼び出し元へ戻らない',
    courseId: 'tuBeginner2',
    lectureIndex: 0,
    java: 'public class Main {\n  public static void main(String[] args) {\n    Turtle a = new Turtle(2, 2); // step\n    Turtle b = new Turtle(4, 2, "B"); // step\n    shift(a, b); // caller\n    a.前に進む(); // step\n    b.後に戻る(); // step\n    a.右を向く(); // step\n    a.前に進む(); // step\n    b.左を向く(); // step\n    b.前に進む(); // step\n  }\n  static void shift(Turtle selected, Turtle other) {\n    selected.右を向く(); // step\n    selected = other; // step\n    selected.左を向く(); // step\n    selected.前に進む(); // step\n  }\n}',
    instrumented:
      "function main() {\nlet a = new Turtle(2, 2); registerDisplayRef('a', () => a); // step\nlet b = new Turtle(4, 2, \"B\"); registerDisplayRef('b', () => b); // step\ncall(Relay.shift.bind(Relay), 'selected', 'other')(a, b); \na.前に進む(); // step\nb.後に戻る(); // step\na.右を向く(); // step\na.前に進む(); // step\nb.左を向く(); // step\nb.前に進む(); // step\n}\nclass Relay {\nstatic shift(selected, other) { registerDisplayRef('selected', () => selected);\nselected.右を向く(); // step\nselected = other; // step\nselected.左を向く(); // step\nselected.前に進む(); // step\n}\n}\nmain();",
    blanks: [
      {
        id: 'Arguments',
        before: '    shift(a, b); // caller',
        after: '    shift(@[a, b]@); // caller',
      },
      {
        id: 'LocalBinding',
        before: '    selected = other; // step',
        after: '    selected = @[other]@; // step',
      },
      {
        id: 'LocalTurn',
        before: '    selected.左を向く(); // step',
        after: '    selected.@[左を向く]@(); // step',
      },
    ],
    bugs: [
      {
        id: 'Arguments',
        before: '    shift(a, b); // caller',
        after: '    shift(b, a); // caller',
        kind: 'logical',
      },
      {
        id: 'LocalBinding',
        before: '    selected = other; // step',
        after: '    selected = selected; // step',
        kind: 'logical',
      },
      {
        id: 'LocalTurn',
        before: '    selected.左を向く(); // step',
        after: '    selected.右を向く(); // step',
        kind: 'logical',
      },
    ],
  },
];
