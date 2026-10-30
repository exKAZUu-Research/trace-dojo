import type { PracticeDefinition } from './types';

export const beginner2PracticeDefinitions = [
  {
    id: 'practiceBeginner2L1A',
    lectureIndex: 0,
    title: '参照をつなぎ替える',
    program: {
      java: `
public class Main {
  public static void main(String[] args) {
    Turtle first = new Turtle(1, 1); // step
    Turtle second = new Turtle(4, 1); // step
    Turtle saved = first; // step
    first = second; // step
    first.右を向く(); // step
    saved.前に進む(); // step
    second.前に進む(); // step
    saved.右を向く(); // step
    first = saved; // step
    first.前に進む(); // step
    second.左を向く(); // step
  }
}
`,
      instrumented: `
let first = new Turtle(1, 1); registerDisplayRef('first', () => first); // step
const second = new Turtle(4, 1); registerDisplayRef('second', () => second); // step
const saved = first; registerDisplayRef('saved', () => saved); // step
first = second; // step
first.右を向く(); // step
saved.前に進む(); // step
second.前に進む(); // step
saved.右を向く(); // step
first = saved; // step
first.前に進む(); // step
second.左を向く(); // step
`,
    },
  },
  {
    id: 'practiceBeginner2L1B',
    lectureIndex: 0,
    title: '残る参照と手放す参照',
    program: {
      java: `
public class Main {
  public static void main(String[] args) {
    Turtle active = new Turtle(2, 2); // step
    Turtle saved = active; // step
    active.前に進む(); // step
    active = new Turtle(5, 1); // step
    active.左を向く(); // step
    saved.右を向く(); // step
    active.前に進む(); // step
    active.remove(); // step
    active = saved; // step
    saved.前に進む(); // step
    active.後に戻る(); // step
  }
}
`,
      instrumented: `
let active = new Turtle(2, 2); registerDisplayRef('active', () => active); // step
const saved = active; registerDisplayRef('saved', () => saved); // step
active.前に進む(); // step
active = new Turtle(5, 1); // step
active.左を向く(); // step
saved.右を向く(); // step
active.前に進む(); // step
active.remove(); // step
active = saved; // step
saved.前に進む(); // step
active.後に戻る(); // step
`,
    },
  },
  {
    id: 'practiceBeginner2L2A',
    lectureIndex: 1,
    title: '別々にたまる歩数',
    program: {
      java: `
public class Main {
  public static void main(String[] args) {
    Walker a = new Walker(1); // caller
    Walker b = new Walker(4); // caller
    a.walk(2); // caller
    b.walk(a.total); // caller
    a.walk(1); // caller
    b.total = a.total - b.total; // step
    b.walk(b.total); // caller
  }
}
class Walker {
  Turtle t;
  int total = 0;
  Walker(int x) {
    this.t = new Turtle(x, 0); // step
  }
  void walk(int amount) {
    for (int i = 0; i < amount; i++) { // step
      this.t.前に進む(); // step
      this.total++; // step
    }
  }
}
`,
      instrumented: `
function main() {
  const a = call(Walker, 'x')(1); registerDisplayRef('a', () => a);
  const b = call(Walker, 'x')(4); registerDisplayRef('b', () => b);
  call(a.walk.bind(a), 'amount')(2);
  call(b.walk.bind(b), 'amount')(a.total);
  call(a.walk.bind(a), 'amount')(1);
  b.total = a.total - b.total; // step
  call(b.walk.bind(b), 'amount')(b.total);
}
class Walker {
  total = 0;
  constructor(x) {
    this.t = new Turtle(x, 0); // step
  }
  walk(amount) {
    for (s.set('i', 0); s.get('i') < amount; s.set('i', s.get('i') + 1)) {
      this.t.前に進む(); // step
      this.total++; // step
    }
    delete s.vars['i'];
  }
}
main();
`,
    },
  },
  {
    id: 'practiceBeginner2L2B',
    lectureIndex: 1,
    title: '作るときに決まる残り回数',
    program: {
      java: `
public class Main {
  public static void main(String[] args) {
    Ticket a = new Ticket(1, 3); // caller
    a.use(); // caller
    Ticket b = new Ticket(4, a.remaining); // caller
    a.use(); // caller
    b.use(); // caller
    b.use(); // caller
  }
}
class Ticket {
  Turtle t;
  int remaining;
  Ticket(int x, int limit) {
    this.t = new Turtle(x, 1); // step
    this.remaining = limit - 1; // step
  }
  void use() {
    if (this.remaining > 0) {
      this.t.前に進む(); // step
      this.remaining--; // step
    } else {
      this.t.右を向く(); // step
    }
  }
}
`,
      instrumented: `
function main() {
  const a = call(Ticket, 'x', 'limit')(1, 3); registerDisplayRef('a', () => a);
  call(a.use.bind(a))();
  const b = call(Ticket, 'x', 'limit')(4, a.remaining); registerDisplayRef('b', () => b);
  call(a.use.bind(a))();
  call(b.use.bind(b))();
  call(b.use.bind(b))();
}
class Ticket {
  constructor(x, limit) {
    this.t = new Turtle(x, 1); // step
    this.remaining = limit - 1; // step
  }
  use() {
    if (this.remaining > 0) {
      this.t.前に進む(); // step
      this.remaining--; // step
    } else {
      this.t.右を向く(); // step
    }
  }
}
main();
`,
    },
  },
  {
    id: 'practiceBeginner2L3A',
    lectureIndex: 2,
    title: '予算の範囲だけ進む',
    program: {
      java: `
public class Main {
  public static void main(String[] args) {
    Budget b = new Budget(); // caller
    b.spend(2); // caller
    b.spend(2); // caller
    b.spend(1); // caller
  }
}
class Budget {
  private Turtle t = new Turtle(1, 1); // step
  private int remaining = 3; // step
  public void spend(int amount) {
    if (amount > 0 && amount <= this.remaining) {
      this.remaining -= amount; // step
      for (int i = 0; i < amount; i++) { // step
        this.t.前に進む(); // step
      }
    } else {
      this.t.右を向く(); // step
    }
  }
}
`,
      instrumented: `
function main() {
  const b = call(Budget)(); registerDisplayRef('b', () => b);
  call(b.spend.bind(b), 'amount')(2);
  call(b.spend.bind(b), 'amount')(2);
  call(b.spend.bind(b), 'amount')(1);
}
class Budget {
  constructor() {
    this.t = new Turtle(1, 1); // step
    this.remaining = 3; // step
  }
  spend(amount) {
    if (amount > 0 && amount <= this.remaining) {
      this.remaining -= amount; // step
      for (s.set('i', 0); s.get('i') < amount; s.set('i', s.get('i') + 1)) {
        this.t.前に進む(); // step
      }
      delete s.vars['i'];
    } else {
      this.t.右を向く(); // step
    }
  }
}
main();
`,
    },
  },
  {
    id: 'practiceBeginner2L3B',
    lectureIndex: 2,
    title: '公開フィールドと消費',
    program: {
      java: `
public class Main {
  public static void main(String[] args) {
    Meter m = new Meter(); // caller
    m.units = 2; // step
    m.consume(); // caller
    m.units += 1; // step
    m.consume(); // caller
    m.consume(); // caller
  }
}
class Meter {
  Turtle t = new Turtle(1, 1); // step
  int units = 0; // step
  void consume() {
    while (this.units > 0) {
      this.t.前に進む(); // step
      this.units--; // step
    }
    this.t.右を向く(); // step
  }
}
`,
      instrumented: `
function main() {
  const m = call(Meter)(); registerDisplayRef('m', () => m);
  m.units = 2; // step
  call(m.consume.bind(m))();
  m.units += 1; // step
  call(m.consume.bind(m))();
  call(m.consume.bind(m))();
}
class Meter {
  constructor() {
    this.t = new Turtle(1, 1); // step
    this.units = 0; // step
  }
  consume() {
    while (this.units > 0) {
      this.t.前に進む(); // step
      this.units--; // step
    }
    this.t.右を向く(); // step
  }
}
main();
`,
    },
  },
  {
    id: 'practiceBeginner2L4A',
    lectureIndex: 3,
    title: '静的メソッドから残りを返す',
    program: {
      java: `
public class Main {
  public static void main(String[] args) {
    Turtle a = new Turtle(1, 1); // step
    Turtle b = new Turtle(4, 1); // step
    int remaining = Relay.spend(a, 3); // step // caller
    remaining = Relay.spend(b, remaining + 1); // step // caller
    remaining = Relay.spend(a, remaining); // step // caller
  }
}
class Relay {
  static int spend(Turtle t, int remaining) {
    while (remaining > 1) {
      t.前に進む(); // step
      remaining--; // step
    }
    return remaining;
  }
}
`,
      instrumented: `
function main() {
  const a = new Turtle(1, 1); registerDisplayRef('a', () => a); // step
  const b = new Turtle(4, 1); registerDisplayRef('b', () => b); // step
  s.set('remaining', call(Relay.spend, 't', 'remaining')(a, 3));
  s.set('remaining', call(Relay.spend, 't', 'remaining')(b, s.get('remaining') + 1));
  s.set('remaining', call(Relay.spend, 't', 'remaining')(a, s.get('remaining')));
}
class Relay {
  static spend(t, remaining) {
    while (s.get('remaining') > 1) {
      t.前に進む(); // step
      s.set('remaining', s.get('remaining') - 1);
    }
    return s.get('remaining');
  }
}
main();
`,
    },
  },
  {
    id: 'practiceBeginner2L4B',
    lectureIndex: 3,
    title: '共有カウンタと各自の距離',
    program: {
      java: `
public class Main {
  public static void main(String[] args) {
    Visitor a = new Visitor(1); // caller
    Visitor b = new Visitor(4); // caller
    a.visit(); // caller
    b.visit(); // caller
    a.visit(); // caller
    int count = Visitor.visits; // step
  }
}
class Visitor {
  static int visits = 0;
  int distance = 0;
  Turtle t;
  Visitor(int x) {
    this.t = new Turtle(x, 0); // step
  }
  void visit() {
    Visitor.visits++; // step
    this.distance = Visitor.visits - this.distance; // step
    for (int i = 0; i < this.distance; i++) { // step
      this.t.前に進む(); // step
    }
  }
}
`,
      instrumented: `
function main() {
  const a = call(Visitor, 'x')(1); registerDisplayRef('a', () => a);
  const b = call(Visitor, 'x')(4); registerDisplayRef('b', () => b);
  call(a.visit.bind(a))();
  call(b.visit.bind(b))();
  call(a.visit.bind(a))();
  s.set('count', Visitor.visits);
}
class Visitor {
  static visits = 0;
  distance = 0;
  constructor(x) {
    this.t = new Turtle(x, 0); // step
  }
  visit() {
    Visitor.visits++; // step
    this.distance = Visitor.visits - this.distance; // step
    for (s.set('i', 0); s.get('i') < this.distance; s.set('i', s.get('i') + 1)) {
      this.t.前に進む(); // step
    }
    delete s.vars['i'];
  }
}
main();
`,
    },
  },
  {
    id: 'practiceBeginner2L5A',
    lectureIndex: 4,
    title: '継承した残り歩数',
    program: {
      java: `
public class Main {
  public static void main(String[] args) {
    Corner c = new Corner(); // caller
    c.advance(); // caller
    c.refill(); // caller
    c.advance(); // caller
  }
}
class Supply {
  Turtle t = new Turtle(1, 1); // step
  int remaining = 1; // step
  void advance() {
    while (this.remaining > 0) {
      this.t.前に進む(); // step
      this.remaining--; // step
    }
  }
}
class Corner extends Supply {
  void refill() {
    this.remaining += 2; // step
    this.t.右を向く(); // step
  }
}
`,
      instrumented: `
function main() {
  const c = call(Corner)(); registerDisplayRef('c', () => c);
  call(c.advance.bind(c))();
  call(c.refill.bind(c))();
  call(c.advance.bind(c))();
}
class Supply {
  constructor() {
    this.t = new Turtle(1, 1); // step
    this.remaining = 1; // step
  }
  advance() {
    while (this.remaining > 0) {
      this.t.前に進む(); // step
      this.remaining--; // step
    }
  }
}
class Corner extends Supply {
  refill() {
    this.remaining += 2; // step
    this.t.右を向く(); // step
  }
}
main();
`,
    },
  },
  {
    id: 'practiceBeginner2L5B',
    lectureIndex: 4,
    title: '基本動作の前後に処理する',
    program: {
      java: `
public class Main {
  public static void main(String[] args) {
    Turning c = new Turning(); // caller
    c.move(); // caller
    c.move(); // caller
  }
}
class Counted {
  Turtle t = new Turtle(2, 2); // step
  int moves = 0; // step
  void move() {
    this.t.前に進む(); // step
    this.moves++; // step
  }
}
class Turning extends Counted {
  @Override void move() {
    if (this.moves == 0) {
      this.t.右を向く(); // step
    }
    super.move(); // caller
    if (this.moves == 2) {
      this.t.左を向く(); // step
    }
  }
}
`,
      instrumented: `
function main() {
  const c = call(Turning)(); registerDisplayRef('c', () => c);
  call(c.move.bind(c))();
  call(c.move.bind(c))();
}
class Counted {
  constructor() {
    this.t = new Turtle(2, 2); // step
    this.moves = 0; // step
  }
  move() {
    this.t.前に進む(); // step
    this.moves++; // step
  }
}
class Turning extends Counted {
  move() {
    if (this.moves == 0) {
      this.t.右を向く(); // step
    }
    call(super.move.bind(this))();
    if (this.moves == 2) {
      this.t.左を向く(); // step
    }
  }
}
main();
`,
    },
  },
  {
    id: 'practiceBeginner2L5C',
    lectureIndex: 4,
    title: '参照先で変わる動作',
    program: {
      java: `
public class Main {
  public static void main(String[] args) {
    Action first = new Forward(); // caller
    Action second = new Sideways(); // caller
    Turtle t = new Turtle(1, 1); // step
    first.apply(t); // caller
    Action saved = first; // step
    first = second; // step
    first.apply(t); // caller
    saved.apply(t); // caller
    second.apply(t); // caller
  }
}
class Action {
  void apply(Turtle t) { }
}
class Forward extends Action {
  @Override void apply(Turtle t) {
    t.前に進む(); // step
  }
}
class Sideways extends Action {
  @Override void apply(Turtle t) {
    t.右を向く(); // step
    t.前に進む(); // step
    t.左を向く(); // step
  }
}
`,
      instrumented: `
function main() {
  let first = call(Forward)(); registerDisplayRef('first', () => first);
  const second = call(Sideways)(); registerDisplayRef('second', () => second);
  const t = new Turtle(1, 1); registerDisplayRef('t', () => t); // step
  call(first.apply.bind(first), 't')(t);
  const saved = first; registerDisplayRef('saved', () => saved); // step
  first = second; // step
  call(first.apply.bind(first), 't')(t);
  call(saved.apply.bind(saved), 't')(t);
  call(second.apply.bind(second), 't')(t);
}
class Action {
  apply(t) { }
}
class Forward extends Action {
  apply(t) {
    t.前に進む(); // step
  }
}
class Sideways extends Action {
  apply(t) {
    t.右を向く(); // step
    t.前に進む(); // step
    t.左を向く(); // step
  }
}
main();
`,
    },
  },
  {
    id: 'practiceBeginner2L6A',
    lectureIndex: 5,
    title: 'パッケージの値を組み合わせる',
    program: {
      java: `
// Main.java
import route.Distance;
public class Main {
  public static void main(String[] args) {
    Turtle t = new Turtle(1, 1); // step
    int steps = Distance.after(1); // step // caller
    for (int i = 0; i < steps; i++) { // step
      t.前に進む(); // step
    }
    t.右を向く(); // step
    steps = route.Distance.after(steps); // step // caller
    for (int i = 0; i < steps; i++) { // step
      t.前に進む(); // step
    }
  }
}
// route/Distance.java
package route;
public class Distance {
  public static int after(int used) {
    return Limits.total - used;
  }
}
// route/Limits.java
package route;
class Limits {
  static int total = 3;
}
`,
      instrumented: `
function main() {
  const t = new Turtle(1, 1); registerDisplayRef('t', () => t); // step
  s.set('steps', call(Distance.after, 'used')(1));
  for (s.set('i', 0); s.get('i') < s.get('steps'); s.set('i', s.get('i') + 1)) {
    t.前に進む(); // step
  }
  delete s.vars['i'];
  t.右を向く(); // step
  s.set('steps', call(Distance.after, 'used')(s.get('steps')));
  for (s.set('i', 0); s.get('i') < s.get('steps'); s.set('i', s.get('i') + 1)) {
    t.前に進む(); // step
  }
  delete s.vars['i'];
}
class Distance {
  static after(used) {
    return Limits.total - used;
  }
}
class Limits {
  static total = 3;
}
main();
`,
    },
  },
  {
    id: 'practiceBeginner2L6B',
    lectureIndex: 5,
    title: '引数の数と残る歩数',
    program: {
      java: `
public class Main {
  public static void main(String[] args) {
    Splitter s = new Splitter(); // caller
    s.move(1, 2); // caller
    s.move(1); // caller
  }
}
class Splitter {
  Turtle t = new Turtle(1, 1); // step
  void move(int first, int second) {
    this.move(first); // caller
    this.t.右を向く(); // step
    this.move(second - first); // caller
  }
  void move(int steps) {
    while (steps > 0) {
      this.t.前に進む(); // step
      steps--; // step
    }
    this.t.左を向く(); // step
  }
}
`,
      instrumented: `
function main() {
  const splitter = call(Splitter)(); registerDisplayRef('s', () => splitter);
  call(splitter.moveTwo.bind(splitter), 'first', 'second')(1, 2);
  call(splitter.moveOne.bind(splitter), 'steps')(1);
}
class Splitter {
  constructor() {
    this.t = new Turtle(1, 1); // step
  }
  moveTwo(first, second) {
    call(this.moveOne.bind(this), 'steps')(first);
    this.t.右を向く(); // step
    call(this.moveOne.bind(this), 'steps')(second - first);
  }
  moveOne(steps) {
    while (s.get('steps') > 0) {
      this.t.前に進む(); // step
      s.set('steps', s.get('steps') - 1);
    }
    this.t.左を向く(); // step
  }
}
main();
`,
    },
  },
  {
    id: 'practiceBeginner2L6C',
    lectureIndex: 5,
    title: '宣言した型と実際の型',
    program: {
      java: `
public class Main {
  public static void main(String[] args) {
    Turtle t = new Turtle(2, 1); // step
    Token token = new SpecialToken(); // caller
    SpecialToken special = new SpecialToken(); // caller
    Router base = new Alternate(); // caller
    base.route(t, token); // caller
    base.route(t, special); // caller
    base.route(t, token); // caller
  }
}
class Token { }
class SpecialToken extends Token { }
class Router {
  void route(Turtle t, Token token) {
    t.前に進む(); // step
  }
  void route(Turtle t, SpecialToken token) {
    t.左を向く(); // step
    this.route(t, (Token) token); // caller
  }
}
class Alternate extends Router {
  @Override void route(Turtle t, Token token) {
    t.右を向く(); // step
    t.前に進む(); // step
  }
}
`,
      instrumented: `
function main() {
  const t = new Turtle(2, 1); registerDisplayRef('t', () => t); // step
  const token = call(SpecialToken)(); registerDisplayRef('token', () => token);
  const special = call(SpecialToken)(); registerDisplayRef('special', () => special);
  const base = call(Alternate)(); registerDisplayRef('base', () => base);
  call(base.routeToken.bind(base), 't', 'token')(t, token);
  call(base.routeSpecial.bind(base), 't', 'token')(t, special);
  call(base.routeToken.bind(base), 't', 'token')(t, token);
}
class Token { }
class SpecialToken extends Token { }
class Router {
  routeToken(t, token) {
    t.前に進む(); // step
  }
  routeSpecial(t, token) {
    t.左を向く(); // step
    call(this.routeToken.bind(this), 't', 'token')(t, token);
  }
}
class Alternate extends Router {
  routeToken(t, token) {
    t.右を向く(); // step
    t.前に進む(); // step
  }
}
main();
`,
    },
  },
  {
    id: 'practiceBeginner2L7A',
    lectureIndex: 6,
    title: '途中の失敗から続ける',
    program: {
      java: `
public class Main {
  public static void main(String[] args) {
    Turtle t = new Turtle(1, 1); // step
    for (int amount = 1; amount <= 3; amount++) { // step
      try {
        advance(t, amount); // caller
        t.左を向く(); // step
      } catch (IllegalArgumentException e) {
        t.右を向く(); // step
      }
    }
    t.前に進む(); // step
  }
  static void advance(Turtle t, int amount) {
    t.前に進む(); // step
    if (amount == 2) {
      throw new IllegalArgumentException("two");
    }
    t.右を向く(); // step
  }
}
`,
      instrumented: `
function main() {
  const t = new Turtle(1, 1); registerDisplayRef('t', () => t); // step
  for (s.set('amount', 1); s.get('amount') <= 3; s.set('amount', s.get('amount') + 1)) {
    try {
      call(advance, 't', 'amount')(t, s.get('amount'));
      t.左を向く(); // step
    } catch (e) {
      t.右を向く(); // step
    }
  }
  delete s.vars['amount'];
  t.前に進む(); // step
}
function advance(t, amount) {
  t.前に進む(); // step
  if (amount == 2) {
    throw new Error('two');
  }
  t.右を向く(); // step
}
main();
`,
    },
  },
  {
    id: 'practiceBeginner2L7B',
    lectureIndex: 6,
    title: '例外が運ぶ残りの距離',
    program: {
      java: `
public class Main {
  public static void main(String[] args) {
    Turtle t = new Turtle(1, 1); // step
    try {
      travel(t, 3); // caller
      t.左を向く(); // step
    } catch (Remainder e) {
      t.右を向く(); // step
      for (int i = 0; i < e.steps; i++) { // step
        t.前に進む(); // step
      }
    }
    t.後に戻る(); // step
  }
  static void travel(Turtle t, int steps) throws Remainder {
    t.前に進む(); // step
    throw new Remainder(steps - 1); // caller
  }
}
class Remainder extends Exception {
  int steps;
  Remainder(int steps) {
    this.steps = steps; // step
  }
}
`,
      instrumented: `
function main() {
  const t = new Turtle(1, 1); registerDisplayRef('t', () => t); // step
  try {
    call(travel, 't', 'steps')(t, 3);
    t.左を向く(); // step
  } catch (e) {
    registerDisplayRef('e', () => e);
    t.右を向く(); // step
    for (s.set('i', 0); s.get('i') < e.steps; s.set('i', s.get('i') + 1)) {
      t.前に進む(); // step
    }
    delete s.vars['i'];
    unregisterDisplayRef('e');
  }
  t.後に戻る(); // step
}
function travel(t, steps) {
  t.前に進む(); // step
  throw call(Remainder, 'steps')(steps - 1);
}
class Remainder extends Error {
  constructor(steps) {
    super();
    this.steps = steps; // step
  }
}
main();
`,
    },
  },
  {
    id: 'practiceBeginner2L8A',
    lectureIndex: 7,
    title: '行ごとに値を書き換える',
    program: {
      java: `
public class Main {
  public static void main(String[] args) {
    Turtle t = new Turtle(1, 1); // step
    int[][] distances = {{1, 1}, {2, 0}}; // step
    for (int row = 0; row < distances.length; row++) { // step
      distances[row][1] += distances[row][0]; // step
      for (int step = 0; step < distances[row][1]; step++) { // step
        t.前に進む(); // step
      }
      t.右を向く(); // step
    }
    distances[0][0] = distances[1][1]; // step
  }
}
`,
      instrumented: `
const t = new Turtle(1, 1); registerDisplayRef('t', () => t); // step
const distances = [[1, 1], [2, 0]]; registerDisplayRef('distances', () => distances); // step
for (s.set('row', 0); s.get('row') < distances.length; s.set('row', s.get('row') + 1)) {
  distances[s.get('row')][1] += distances[s.get('row')][0]; // step
  for (s.set('step', 0); s.get('step') < distances[s.get('row')][1]; s.set('step', s.get('step') + 1)) {
    t.前に進む(); // step
  }
  delete s.vars['step'];
  t.右を向く(); // step
}
delete s.vars['row'];
distances[0][0] = distances[1][1]; // step
`,
    },
  },
  {
    id: 'practiceBeginner2L8B',
    lectureIndex: 7,
    title: '別の層から値を受け取る',
    program: {
      java: `
public class Main {
  public static void main(String[] args) {
    Turtle t = new Turtle(1, 1); // step
    int[][][] distances = {{{1, 2}}, {{2, 1}}}; // step
    distances[1][0][1] += distances[0][0][0]; // step
    distances[0][0][0] = distances[1][0][0]; // step
    for (int layer = 1; layer >= 0; layer--) { // step
      for (int step = 0; step < distances[layer][0][layer]; step++) { // step
        t.前に進む(); // step
      }
      t.右を向く(); // step
    }
  }
}
`,
      instrumented: `
const t = new Turtle(1, 1); registerDisplayRef('t', () => t); // step
const distances = [[[1, 2]], [[2, 1]]]; registerDisplayRef('distances', () => distances); // step
distances[1][0][1] += distances[0][0][0]; // step
distances[0][0][0] = distances[1][0][0]; // step
for (s.set('layer', 1); s.get('layer') >= 0; s.set('layer', s.get('layer') - 1)) {
  for (s.set('step', 0); s.get('step') < distances[s.get('layer')][0][s.get('layer')]; s.set('step', s.get('step') + 1)) {
    t.前に進む(); // step
  }
  delete s.vars['step'];
  t.右を向く(); // step
}
delete s.vars['layer'];
`,
    },
  },
] satisfies PracticeDefinition[];
