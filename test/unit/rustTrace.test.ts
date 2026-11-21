import { expect, test } from 'vitest';

import { traceProgram } from '../../src/interpreter/program';
import type { TraceItem } from '../../src/problems/trace';

const javaMain = (body: string, members = ''): string => `public class Main {
  public static void main(String[] args) {
${body}
  }
${members}
}`;

/** The programs of the two languages place their statements on different lines, so their steps compare without them. */
const withoutLines = (items: TraceItem[]): unknown[] =>
  items.map(({ line, callLines, ...item }) => ({ ...item, callDepth: callLines.length }));

/** Java's `this.x` is Rust's `self.x`. */
const rename = (items: unknown[]): string =>
  JSON.stringify(items).replaceAll('"this.', '"self.').replaceAll('"this"', '"self"');

/** Programs that behave alike in both languages, so Rust must reproduce the Java interpreter's trace. */
test.each([
  {
    name: 'variables, conditions, and while loops',
    java: javaMain(`
    Turtle t = new Turtle();
    int n = 4;
    int i = 0;
    while (i < n) {
      if (i % 2 == 0) {
        t.前に進む();
      } else {
        t.右を向く();
      }
      i++;
    }`),
    rust: `fn main() {
    let mut t = Turtle::new();
    let n = 4;
    let mut i = 0;
    while i < n {
        if i % 2 == 0 {
            t.前に進む();
        } else {
            t.右を向く();
        }
        i += 1;
    }
}`,
  },
  {
    name: 'a method marked atomic and a function that returns a value',
    java: javaMain(
      `
    Turtle t = new Turtle(1, 1);
    int x = twice(2);
    walk(t, x);
    t.turnLeft();`,
      `
  static void walk(Turtle t, int n) { // atomic
    for (int i = 0; i < n; i++) {
      t.forward();
    }
  }
  static int twice(int a) {
    return a * 2;
  }`
    ),
    rust: `fn main() {
    let mut t = Turtle::new(1, 1);
    let x = twice(2);
    walk(&mut t, x);
    t.turnLeft();
}

fn walk(t: &mut Turtle, n: i32) { // atomic
    for _ in 0..n {
        t.forward();
    }
}

fn twice(a: i32) -> i32 {
    return a * 2;
}`,
  },
])('Rust traces as Java does: $name', ({ java, rust }) => {
  const javaTrace = traceProgram('java', java, java);
  const rustTrace = traceProgram('rust', rust, rust);
  expect(rename(withoutLines(rustTrace.traceItems))).toBe(rename(withoutLines(javaTrace.traceItems)));
  expect(rustTrace.traceItems.at(-1)?.board).toBe(javaTrace.traceItems.at(-1)?.board);
});

test("a method's receiver shows its fields as self.x, as Java shows this.x", () => {
  const program = `fn main() {
    let mut s = Signal { t: Turtle::new(2, 2), turn: false };
    s.act();
    s.turn = true;
    s.act();
}

struct Signal {
    t: Turtle,
    turn: bool,
}

impl Signal {
    fn act(&mut self) {
        if self.turn {
            self.t.右を向く();
        }
        self.t.前に進む();
    }
}`;
  const { traceItems } = traceProgram('rust', program, program);
  expect(traceItems.map(({ line, vars }) => [line, vars])).toEqual([
    [0, {}],
    [2, {}],
    [18, { 'self.turn': false }],
    [4, {}],
    [16, { 'self.turn': true }],
    [18, { 'self.turn': true }],
  ]);
});

test('a turtle disappears at the step that drops it', () => {
  const program = `fn main() {
    let mut t1 = Turtle::new(1, 1);
    let mut t2 = Turtle::new(3, 3);
    t2 = t1;
    t2.前に進む();
}`;
  const { traceItems } = traceProgram('rust', program, program);
  expect(traceItems.map(({ line, turtles }) => [line, turtles.map(({ x, y }) => `${x},${y}`).join(' ')])).toEqual([
    [0, ''],
    [2, '1,1'],
    [3, '1,1 3,3'],
    [4, '1,1'],
    [5, '1,2'],
  ]);
});

test('turtles moved out by a loop, a pattern, or a field disappear when what took them drops them', () => {
  const program = `fn main() {
    let v = vec![Turtle::new(1, 1), Turtle::new(3, 3)];
    for t in v {
        let n = 1;
    }
    let pair = (Turtle::new(5, 5), Turtle::new(6, 6));
    let (a, b) = pair;
    drop(a);
    let o = Some(Turtle::new(0, 0));
    if let Some(t) = o {
        let n = 2;
    }
    let x = 3;
}`;
  const { traceItems } = traceProgram('rust', program, program);
  expect(traceItems.map(({ line, turtles }) => [line, turtles.map(({ x, y }) => `${x},${y}`).join(' ')])).toEqual([
    [0, ''],
    [2, '1,1 3,3'],
    [4, '1,1 3,3'],
    [3, '3,3'],
    [4, '3,3'],
    [6, '5,5 6,6'],
    [7, '5,5 6,6'],
    [8, '6,6'],
    [9, '6,6 0,0'],
    [11, '6,6 0,0'],
    [13, '6,6'],
  ]);
});

test('a part moved out of a tuple or a struct leaves the variable that held it', () => {
  const program = `struct S { a: String, b: i32 }
fn main() {
    let t = (String::from("x"), 1);
    let first = t.0;
    let s = S { a: String::from("y"), b: 2 };
    let a = s.a;
    let n = 0;
}`;
  const { traceItems } = traceProgram('rust', program, program);
  expect(traceItems.at(-1)?.referenceVars).toEqual({
    t: { kind: 'object', entries: { 1: { kind: 'value', value: 1 } } },
    s: { kind: 'object', entries: { b: { kind: 'value', value: 2 } } },
  });
});

test('a shared reference shows the current value of what it refers to', () => {
  const program = `fn main() {
    let mut x = 1;
    let mut s = String::from("a");
    let rx = &x;
    let rs = &s;
    println!("{} {}", rx, rs);
    x = 2;
    s.push('b');
    let n = 0;
}`;
  const { traceItems } = traceProgram('rust', program, program);
  expect(traceItems.at(-1)?.vars).toEqual({ x: 2, s: 'ab', rx: 2, rs: 'ab', n: 0 });
});

test('a for loop records a step at each binding of its variable, and none after the last', () => {
  const program = `fn main() {
    let mut t = Turtle::new();
    for i in 0..2 {
        t.前に進む();
    }
}`;
  const { traceItems } = traceProgram('rust', program, program);
  expect(traceItems.map(({ line, vars }) => [line, vars])).toEqual([
    [0, {}],
    [2, {}],
    [3, { i: 0 }],
    [4, { i: 0 }],
    [3, { i: 1 }],
    [4, { i: 1 }],
  ]);
});

test('a stale Rust reference disappears from the trace when its referent moves', () => {
  const program = `fn main() {
    let mut values = vec![String::from("a")];
    let borrowed = &mut values;
    borrowed.push(String::from("b"));
    let shared = &values;
    println!("{}", shared.len());
    let moved = values;
    println!("{}", moved.len());
}`;
  const { traceItems, finalVars, stdout } = traceProgram('rust', program, program);
  expect(stdout).toBe('2\n2\n');
  expect(traceItems.some(({ vars }) => Array.isArray(vars.borrowed))).toBe(true);
  expect(traceItems.at(-1)?.referenceVars).not.toHaveProperty('borrowed');
  expect(traceItems.at(-1)?.referenceVars).not.toHaveProperty('shared');
  expect(finalVars).toEqual({ moved: ['a', 'b'] });
});

test('a shadowing Rust binding replaces the previous trace display', () => {
  const program = `struct Item { count: i32 }
fn main() {
    let value = 7;
    let value = Item { count: 8 };
    println!("{}", value.count);
    let value = value.count + 1;
    println!("{}", value);
}`;
  const { traceItems } = traceProgram('rust', program, program);
  const aggregate = traceItems.find(({ line }) => line === 5);
  expect(aggregate?.vars).not.toHaveProperty('value');
  expect(aggregate?.referenceVars).toHaveProperty('value');
  expect(traceItems.at(-1)?.vars).toEqual({ value: 9 });
  expect(traceItems.at(-1)?.referenceVars).not.toHaveProperty('value');
});

test('ordered collections compare keys during mutation and lookup while trace inspection uses stored order', () => {
  const program = `use std::collections::{BTreeMap, BTreeSet};
use std::cmp::Ordering;
#[derive(Debug)]
struct Key(i32);
impl PartialEq for Key {
    fn eq(&self, other: &Self) -> bool { self.0 % 10 == other.0 % 10 }
}
impl Eq for Key {}
impl Ord for Key {
    fn cmp(&self, other: &Self) -> Ordering {
        println!("cmp {} {}", self.0, other.0);
        (self.0 % 10).cmp(&(other.0 % 10))
    }
}
impl PartialOrd for Key {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> { Some(self.cmp(other)) }
}

fn main() {
    let mut set = BTreeSet::new();
    let mut map = BTreeMap::new();
    set.insert(Key(2));
    set.insert(Key(1));
    set.insert(Key(11));
    println!("set {:?} {}", set, set.contains(&Key(21)));
    map.insert(Key(1), 1);
    *map.entry(Key(11)).or_insert(2) += 4;
    println!("map {:?} {}", map, map[&Key(21)]);
    println!("removed {:?} {:?}", map.remove(&Key(31)), set.remove(&Key(31)));
}`;
  expect(traceProgram('rust', program, program)).toMatchObject({
    stdout: `cmp 1 2
cmp 11 1
cmp 21 1
set {Key(1), Key(2)} true
cmp 11 1
cmp 21 1
map {Key(1): 5} 5
cmp 31 1
cmp 31 1
removed Some(5) true
`,
    uncaughtException: undefined,
  });
});

test('Rust traces forget a String consumed by concatenation and preserve its capacity', () => {
  const program = `fn main() {
    let mut s = String::with_capacity(100);
    s.push_str("a");
    let combined = s + "b";
    println!("{}", combined.capacity());
}`;
  const { finalVars, stdout } = traceProgram('rust', program, program);
  expect(stdout).toBe('100\n');
  expect(finalVars).toEqual({ combined: 'ab' });
});

test('a moved Rust binding keeps an older binding shadowed', () => {
  const program = `fn main() {
    let item = 1;
    {
        let item = String::from("hi");
        let owned = item;
        println!("{}", owned);
    }
    println!("{}", item);
    let item = String::from("last");
    drop(item);
}`;
  const { traceItems, finalVars, stdout } = traceProgram('rust', program, program);
  expect(stdout).toBe('hi\n1\n');
  expect(traceItems.find(({ vars }) => vars.owned === 'hi')?.vars).toEqual({ owned: 'hi' });
  expect(finalVars).toEqual({});
});

test('places Rust receiver fields after the method parameters and locals', () => {
  const program = `struct Walker { speed: i32 }
impl Walker {
    fn walk(&self, times: i32) -> i32 {
        let distance = self.speed * times;
        distance
    }
}
fn main() {
    let walker = Walker { speed: 2 };
    let _ = walker.walk(3);
}`;
  const trace = traceProgram('rust', program, program);
  const method = trace.traceItems.find((step) => step.vars.distance === 6);
  expect(Object.keys(method?.vars ?? {})).toEqual(['times', 'distance', 'self.speed']);
});

test('traces Rust statements on their own lines after doc comments', () => {
  const program = `fn main() {
    /// turtle
    let mut t = Turtle::new();
    /** move */
    t.forward();
    println!("ok");
}`;
  const trace = traceProgram('rust', program, program);
  expect(trace.traceItems.map((step) => step.line)).toEqual([0, 3, 5, 6]);
});

test('Rust records value branch assignments once while preserving interior statements', () => {
  const program = `fn main() {
    let mut n = 6;
    let label = if n % 2 == 0 { "even" } else { "odd" };
    n = if n == 6 { 3 } else { 1 };
    let result = { let previous = n; previous + 1 };
    let by_match = match result { 4 => { 5 }, _ => { 6 } };
}`;
  const { traceItems } = traceProgram('rust', program, program);
  expect(traceItems.map(({ line, vars }) => [line, vars])).toEqual([
    [0, {}],
    [2, { n: 6 }],
    [3, { n: 6, label: 'even' }],
    [4, { n: 3, label: 'even' }],
    [5, { n: 3, label: 'even', previous: 3 }],
    [5, { n: 3, label: 'even', result: 4 }],
    [6, { n: 3, label: 'even', result: 4, by_match: 5 }],
  ]);
});

test('Rust traces brace-free statement match arms as Java switch cases', () => {
  const program = `fn main() {
    let mut t = Turtle::new();
    for command in [0, 1, 2] {
        match command {
            0 => t.forward(),
            1 => { t.turn_right(); t.forward(); }
            _ => t.turn_left(),
        }
    }
}`;
  const { traceItems } = traceProgram('rust', program, program);
  expect(traceItems.map(({ line }) => line)).toEqual([0, 2, 3, 5, 3, 6, 6, 3, 7]);
});

test('drops shared-reference aliases when their binding scope ends', () => {
  const source = `fn main() {
    let mut n = 1;
    {
        let r = &n;
        let r2 = r;
        println!("{}", r2);
    }
    n = 2;
}`;
  expect(traceProgram('rust', source, source).finalVars).toEqual({ n: 2 });
});

test('traces the live value of an indexed referent without rerunning the index', () => {
  const program = `fn main() {
    let mut items = vec![1, 2];
    let first = &items[{ println!("index"); 0 }];
    let alias = first;
    println!("{}", alias);
    items[0] = 9;
    let done = true;
  }`;
  const trace = traceProgram('rust', program, program);
  expect(trace.stdout).toBe('index\n1\n');
  expect(trace.finalVars).toEqual({ items: [9, 2], first: 9, alias: 9, done: true });
});
