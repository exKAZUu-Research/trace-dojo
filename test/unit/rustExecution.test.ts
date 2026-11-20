import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

const rustMain = (body: string, items = ''): string => `${items ? `${items}\n` : ''}fn main() {
${body}
}
`;

test('a program that draws reports its final board and the turtles still owned', () => {
  const execution = executeProgram(
    'rust',
    rustMain(
      `    let mut keep = Turtle::new(1, 1, "G");
    draw();
    keep.右を向く();
    keep.forward();`,
      `fn draw() {
    let mut temporary = Turtle::new(4, 4, "Y");
    temporary.turn_left();
    temporary.前に進む();
}`
    )
  );
  expect(execution).toEqual({
    kind: 'executed',
    finalBoard: ['.......', '.GG....', '.......', '.......', '...YY..', '.......', '.......'].join('\n'),
    finalTurtles: [{ x: 2, y: 1, color: 'G', dir: 'E' }],
    uncaughtException: undefined,
    stdout: '',
    stderr: '',
    finalFiles: {},
  });
});

// The expected texts are what rustc 1.99.1 (edition 2024) prints for the same program.
test('values print as rustc prints them', () => {
  const program = rustMain(String.raw`    println!("[{:.2}] [{:.2}] [{:.0}] [{:.0}]", 0.125, 0.135, 2.5, 3.5);
    println!("{} {:?} {:?} {:?} {}", -0.0f64, 1e15, 1e16, 1e-5, 1e21);
    println!("{:?} {:?} {:?}", (-0.5f64).round_ties_even(), (-0.5f32).round_ties_even(), 0.5f64.round_ties_even());
    println!("{} {} {} {}", 2.0_f64.powi(i32::MIN), 0.5_f32.powi(i32::MIN), (-1.0_f64).powi(i32::MIN), (-0.0_f32).powi(i32::MIN));
    println!("{:?} {} {}", 0.1f32 + 0.2f32, 0.1 + 0.2, 123456789.0f32);
    println!("[{:>6}] [{:<4}] [{:^7}] [{:05}] [{:+}] [{:#x}] [{:#010b}] [{:e}]", 42, 7, "ab", -42, 5, 255, 5, 1234.5);
    println!("{:?} {:5?} {:?}", (1, "a", 'c', Some(2.5)), Some(1), "q\"\n");
    #[derive(Debug)]
    struct P { x: i32, v: Vec<f64> }
    println!("{:#?}", P { x: 1, v: vec![1.0] });`);
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: `[0.12] [0.14] [2] [4]
-0 1000000000000000.0 1e16 1e-5 1000000000000000000000
-0.0 -0.0 0.0
0 inf 1 inf
0.3 0.30000000000000004 123456790
[    42] [7   ] [  ab   ] [-0042] [+5] [0xff] [0b00000101] [1.2345e3]
(1, "a", 'c', Some(2.5)) Some(    1) "q\\"\\n"
P {
    x: 1,
    v: [
        1.0,
    ],
}
`,
  });
});

test.each([
  {
    name: 'integer overflow in a debug build',
    body: '    let mut x: u8 = 250;\n    for _ in 0..10 { x += 1; }',
    message: 'panicked at src/main.rs:3:22:\nattempt to add with overflow',
  },
  {
    name: "a Vec's index, reported at its bracket",
    body: '    let v = vec![1, 2, 3];\n    let i = v.len() + 1;\n    println!("{}", v[i]);',
    message: 'panicked at src/main.rs:4:21:\nindex out of bounds: the len is 3 but the index is 4',
  },
  {
    name: 'unwrap of an Err, reported at the method',
    body: '    let n: i32 = "4x".parse().unwrap();',
    message:
      'panicked at src/main.rs:2:31:\ncalled `Result::unwrap()` on an `Err` value: ParseIntError { kind: InvalidDigit }',
  },
  {
    name: 'a string sliced inside a character',
    body: '    let s = String::from("héllo");\n    let t = &s[..2];',
    message:
      "panicked at src/main.rs:3:15:\nend byte index 2 is not a char boundary; it is inside 'é' (bytes 1..3 of string)",
  },
  {
    name: 'overflow on a borrowed variable, which rustc does not propagate before running',
    body: '    let x: u8 = 255;\n    let y = x + 1;\n    println!("{} {}", x, y);',
    message: 'panicked at src/main.rs:3:13:\nattempt to add with overflow',
  },
])('panics end the program as rustc reports them: $name', ({ body, message }) => {
  const execution = executeProgram('rust', rustMain(body));
  expect(execution).toMatchObject({ kind: 'executed' });
  expect(execution.kind === 'executed' && execution.uncaughtException).toBe(
    `thread 'main' (1) ${message}\nnote: run with \`RUST_BACKTRACE=1\` environment variable to display a backtrace`
  );
});

test('main returning an Err reports it with Debug', () => {
  const program = `fn main() -> Result<(), String> {
    println!("start");
    Err(String::from("empty"))
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: 'start\n',
    uncaughtException: 'Error: "empty"',
  });
});

test.each([
  'fn main() -> i32 { 0 }',
  'fn main() -> Result<i32, String> { Ok(0) }',
  'struct Error; fn main() -> Result<(), Error> { Err(Error) }',
])('Rust rejects a main return type without Termination: %s', (program) => {
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'compileError',
    diagnostics: [expect.objectContaining({ message: expect.stringContaining('Termination') })],
  });
});

test('Rust reports an error nested in a successful main Result', () => {
  const program = 'fn main() -> Result<Result<(), String>, String> { Ok(Err(String::from("nested"))) }';
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: 'Error: "nested"',
  });
});

test('programs that learners commonly write run as rustc runs them', () => {
  const program = `use std::collections::HashMap;
#[derive(Debug)]
struct User { name: String, email: String }
fn add(out: &mut Vec<i32>, x: i32) { out.push(x); }
fn twice(out: &mut Vec<i32>) { add(out, 1); add(out, 2); }
fn main() {
    let (_, b) = (1, 2);
    if let Some(_) = Some(b) { println!("some"); }
    let s = String::from("A");
    println!("{} {}", s == "A", "B" != s);
    let mut v = Vec::new();
    twice(&mut v);
    for (x, _) in v.iter_mut().zip(0..) { *x *= 10; }
    let mut m = Some(3);
    if let Some(x) = &mut m { *x += 1; }
    let u1 = User { name: String::from("a"), email: String::from("e") };
    let u2 = User { name: String::from("b"), ..u1 };
    let mut freq: HashMap<String, i32> = HashMap::new();
    for w in "x y x".split(' ') { *freq.entry(w.to_string()).or_insert(0) += 1; }
    let mut pairs: Vec<_> = freq.iter().collect();
    pairs.sort_by(|a, b| b.1.cmp(a.1));
    let mut c = "rust".chars();
    let first = c.next().unwrap().to_uppercase().collect::<String>() + c.as_str();
    println!("{:?} {:?} {} {:?} {:?} {} {:?}", v, m, u1.name, u2, pairs, first, "ab".rfind(""));
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: `some
true true
[10, 20] Some(4) a User { name: "b", email: "e" } [("x", 2), ("y", 1)] Rust Some(2)
`,
    uncaughtException: undefined,
  });
});

test('failed patterns leave owned values available to later matches and let-else blocks', () => {
  const program = `struct Item { name: String, code: i32 }

fn take(item: Item) {
    let Item { name, code: 0 } = item else {
        println!("kept {}", item.name);
        return;
    };
    println!("matched {}", name);
}

fn main() {
    let pair = (String::from("tuple"), 1);
    match pair {
        (value, 0) => println!("first {}", value),
        (value, _) => println!("second {}", value),
    }
    let pair = (String::from("alternative"), 1);
    match pair {
        (value, 0) | (value, 1) => println!("matched {}", value),
        _ => (),
    }
    take(Item { name: String::from("struct"), code: 1 });
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: 'second tuple\nmatched alternative\nkept struct\n',
    uncaughtException: undefined,
  });
});

test('composite collection keys preserve delimiters within strings', () => {
  const program = rustMain(
    `    let first = ("a,sb", "c");
    let second = ("a", "b,sc");
    let mut map = HashMap::new();
    map.insert(first, 1);
    map.insert(second, 2);
    println!("{} {:?}", map.len(), map.get(&first));
    println!("{:?} {:?}", map.remove(&first), map.get(&second));

    let mut set = BTreeSet::new();
    set.insert(vec!["a,sb".to_string(), "c".to_string()]);
    set.insert(vec!["a".to_string(), "b,sc".to_string()]);
    println!("{}", set.len());`,
    'use std::collections::{BTreeSet, HashMap};'
  );
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: '2 Some(1)\nSome(1) Some(2)\n2\n',
    uncaughtException: undefined,
  });
});

test('closures, map keys, slices, and Debug builders run as rustc runs them', () => {
  const program = `use std::collections::HashMap;
use std::fmt;
struct P { x: i32 }
impl fmt::Debug for P {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.debug_struct("P").field("x", &self.x).finish()
    }
}
fn main() {
    let name = String::from("n");
    let take = move || name + "!";
    println!("{}", take());
    let mut m: HashMap<&str, i32> = HashMap::new();
    m.insert("a", 1);
    let keys: Vec<&&str> = m.keys().collect();
    println!("{}", m[*keys[0]]);
    let v = vec![1, 2, 3];
    println!("{:?} {:?} {}", v.get(1..), v.get(9), [0; 2 + 1].len());
    let total: Result<Vec<i32>, String> = vec!["1", "x", "y"].iter().map(|s| s.parse::<i32>().map_err(|e| e.to_string())).collect();
    println!("{:?} {:#?}", total, vec![P { x: 1 }]);
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: `n!
1
Some([2, 3]) None 3
Err("invalid digit found in string") [
    P {
        x: 1,
    },
]
`,
    uncaughtException: undefined,
  });
});

test('Rust UTF-8 conversions and string operations preserve U+FEFF', () => {
  const program = String.raw`fn main() {
    let strict = String::from_utf8(vec![239, 187, 191, 65]).unwrap();
    let lossy = String::from_utf8_lossy(&[239, 187, 191, 255]);
    let mut head = String::from("\u{feff}A");
    head.truncate(3);
    println!("{} {} {}", strict.len(), lossy.len(), head.len());
    println!("{} {}", &strict[..3] == "\u{feff}", "\u{feff},B".split(',').next().unwrap() == "\u{feff}");
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: '4 6 3\ntrue true\n',
    uncaughtException: undefined,
  });
});

test('reverse string searches select the rightmost match and visit predicates from the right', () => {
  const program = `fn main() {
    println!("{:?} {:?}", "ababa".rsplit_once("aba"), "aaaa".rsplit_once("aaa"));
    println!("{:?}", "📚".rsplit_once(""));
    let split = "a界b".rsplit_once(|c| { print!("{}", c); c == '界' });
    println!(" {:?}", split);
    let index = "a界b".rfind(|c| { print!("{}", c); c == '界' });
    println!(" {:?}", index);
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: 'Some(("ab", "")) Some(("a", ""))\nSome(("📚", ""))\nb界 Some(("a", "b"))\nb界 Some(1)\n',
    uncaughtException: undefined,
  });
});

test('Rust Unicode whitespace preserves U+FEFF and recognizes U+0085', () => {
  const program = String.raw`fn main() {
    let text = "\u{85}\u{feff}a\u{feff}b\u{a0}";
    println!("{} {}", '\u{85}'.is_whitespace(), '\u{feff}'.is_whitespace());
    println!("{} {}", text.trim() == "\u{feff}a\u{feff}b", text.split_whitespace().count());
    println!("{}", "a\u{85}b".split_whitespace().count());
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: 'true false\ntrue 1\n2\n',
    uncaughtException: undefined,
  });
});

test('Rust slice indexing evaluates the container before the bounds', () => {
  const program = `fn numbers() -> Vec<i32> { println!("numbers"); vec![1, 2, 3] }
fn text() -> String { println!("text"); String::from("abc") }
fn bound() -> usize { println!("bound"); 1 }

fn main() {
    println!("{:?}", &numbers()[bound()..]);
    println!("{}", &text()[..bound()]);
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: 'numbers\nbound\n[2, 3]\ntext\nbound\na\n',
    uncaughtException: undefined,
  });
});

test('Rust constant checks follow compound assignments', () => {
  const program = `fn main() {
    let mut divisor = 0;
    divisor += 1;
    println!("{}", 10 / divisor);

    let values = [1, 2, 3];
    let mut index = 5;
    index -= 3;
    println!("{}", values[index]);

    let mut n: u8 = 250;
    n -= 100;
    println!("{}", n + 10);
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: '10\n3\n160\n',
    uncaughtException: undefined,
  });
});

test('assigning a Rust String replaces capacity even when its text is unchanged', () => {
  const program = `fn replace(target: &mut String) { *target = String::new(); }
fn main() {
    let mut empty = String::with_capacity(10);
    empty = String::new();
    let mut text = String::from("abc");
    text.reserve(32);
    text = String::from("abc");
    let mut values = vec![String::with_capacity(20)];
    replace(&mut values[0]);
    println!("{} {} {}", empty.capacity(), text.capacity(), values[0].capacity());
    empty = String::with_capacity(12);
    println!("{}", empty.capacity());
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: '0 3 0\n12\n',
    uncaughtException: undefined,
  });
});

test('Rust block items and imports stop shadowing names when their block ends', () => {
  const program = `mod first { pub fn value() -> i32 { 1 } }
mod second { pub fn value() -> i32 { 2 } }
use first::value as imported;

fn number() -> i32 { 10 }
fn main() {
    {
        use second::value as imported;
        fn number() -> i32 { 20 }
        println!("{} {}", number(), imported());
    }
    println!("{} {}", number(), imported());
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: '20 2\n10 1\n',
    uncaughtException: undefined,
  });
});

test('Rust constants use their declaration scope and initializer locals', () => {
  const program = `const BASE: i32 = 10;
mod numbers {
    const BASE: i32 = 3;
    pub const LIMIT: i32 = BASE + 1;
    pub struct Number;
    impl Number {
        const FACTOR: i32 = 2;
        pub const TOTAL: i32 = LIMIT * Self::FACTOR;
    }
}

fn main() {
    const LOCAL: i32 = { let addition = 2; BASE + addition };
    {
        const BASE: i32 = 5;
        const NESTED: i32 = BASE + LOCAL;
        println!("{} {} {}", numbers::LIMIT, numbers::Number::TOTAL, NESTED);
    }
    println!("{}", LOCAL);
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: '4 8 17\n12\n',
    uncaughtException: undefined,
  });
});

test('Rust byte literals accept the full hexadecimal byte range', () => {
  const program = String.raw`fn main() {
    println!("{} {} {} {}", b'a', b'\n', b'\x80', b'\xFF');
    match b'\xFF' {
        b'\xFF' => println!("matched"),
        _ => (),
    }
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: '97 10 128 255\nmatched\n',
    uncaughtException: undefined,
  });
});

test('a Rust PartialOrd implementation can leave its values unordered', () => {
  const program = `use std::cmp::Ordering;
#[derive(PartialEq)]
struct P(i32);
impl PartialOrd for P {
    fn partial_cmp(&self, _other: &Self) -> Option<Ordering> {
        print!("cmp ");
        None
    }
}

fn main() {
    println!("{} {} {} {} {:?}",
        P(1) < P(2), P(1) <= P(2), P(2) > P(1), P(2) >= P(1),
        P(1).partial_cmp(&P(2)));
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: 'cmp cmp cmp cmp cmp false false false false None\n',
    uncaughtException: undefined,
  });
});

test('Rust while-let bindings can reborrow each element of a mutable list', () => {
  const program = `struct Node { value: i32, next: Option<Box<Node>> }

fn bump(head: &mut Option<Box<Node>>) {
    let mut cursor = head;
    while let Some(node) = cursor {
        node.value += 1;
        cursor = &mut node.next;
    }
}

fn main() {
    let mut list = Some(Box::new(Node {
        value: 1,
        next: Some(Box::new(Node { value: 2, next: None })),
    }));
    bump(&mut list);
    let node = list.unwrap();
    println!("{} {}", node.value, node.next.unwrap().value);
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: '2 3\n',
    uncaughtException: undefined,
  });
});

test.each([
  [`fn main() { let _ = "日本é𐐀🦀́"; dbg!(1); let v = vec![0]; println!("{}", v[5]); }`, '1:31', '1:75'],
  ['fn main() {\n\tlet _ = "日本語"; let v = vec![0]; dbg!(1); println!("{}", v[5]);\n}', '2:34', '2:65'],
])('Rust uses scalar columns for dbg! and display columns for panics: %s', (program, dbg, panic) => {
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stderr: `[src/main.rs:${dbg}] 1 = 1\n`,
    uncaughtException: expect.stringContaining(`panicked at src/main.rs:${panic}:\n`),
  });
});

test('Rust formatting traits can be imported by alias or anonymously', () => {
  const program = `mod named {
    use std::fmt::Write as FmtWrite;
    pub fn render() -> String {
        let mut s = String::new();
        write!(&mut s, "first").unwrap();
        s
    }
}
mod anonymous {
    use std::fmt::Write as _;
    use std::fmt::Display as _;
    pub fn render() -> String {
        let mut s = String::new();
        writeln!(&mut s, "second").unwrap();
        s
    }
}
fn main() {
    println!("{} {}", named::render(), anonymous::render().trim());
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: 'first second\n',
    uncaughtException: undefined,
  });
});

test('Rust owned sequence conversions clone borrowed items and move owned items', () => {
  const program = `fn main() {
    let source = [vec![1]];
    let mut vector = Vec::from(&source);
    let mut boxed: Box<[Vec<i32>]> = Box::from(&source[..]);
    vector[0].push(2);
    boxed[0].push(3);
    println!("{:?} {:?} {:?}", source, vector, boxed);

    struct NonClone(i32);
    let owned = Vec::from([NonClone(4)]);
    println!("{}", owned[0].0);
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: '[[1]] [[1, 2]] [[1, 3]]\n4\n',
    uncaughtException: undefined,
  });
});

test.each([
  ['BTreeSet', '    let tree: BTreeSet<i32> = [1, 2].into();', 119, ''],
  [
    'BTreeMap',
    '    let mut tree = BTreeMap::<i32, i32>::new();\n    println!("{}", tree.range(3..1).count());\n    tree.insert(1, 2);\n    tree.remove(&1);',
    121,
    '0\n',
  ],
])('Rust %s validates reversed ranges when its tree has a root', (name, setup, line, stdout) => {
  const program = rustMain(`${setup}\n    println!("{}", tree.range(3..1).count());`, `use std::collections::${name};`);
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout,
    uncaughtException: expect.stringContaining(
      `library/alloc/src/collections/btree/search.rs:${line}:21:\nrange start is greater than range end in ${name}`
    ),
  });
});

test('Rust derives can use manually implemented supertraits with generic bounds', () => {
  const program = `#[derive(Copy)]
struct Number<T>(T);
impl<T: Clone> Clone for Number<T> {
    fn clone(&self) -> Self { Self(self.0.clone()) }
}

fn main() {
    let original = Number(3);
    let copied = original;
    println!("{} {}", original.0, copied.0);
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: '3 3\n',
    uncaughtException: undefined,
  });
});

test('overflow in an open-ended Rust range reports the library location', () => {
  const program = rustMain(`    let mut values = (u64::MAX - 1)..;
    println!("{:?}", values.next());
    println!("{:?}", values.next());`);
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: 'Some(18446744073709551614)\n',
    uncaughtException: expect.stringContaining('library/core/src/iter/range.rs:548:1:\nattempt to add with overflow'),
  });
});

test('Rust keeps evaluated arguments and aggregate values live while evaluating later operands', () => {
  const program = `struct Holder { turtle: Turtle }
impl Holder {
    fn report(self, clear: bool) { println!("{}", clear); }
}
fn report(turtle: Turtle, clear: bool) { println!("{}", clear); }
fn release(turtle: Turtle, observer: &mut Turtle) {
    std::mem::drop(turtle);
    println!("{}", observer.canMoveForward());
}

fn main() {
    let mut observer = Turtle::new(0, 0);
    report(Turtle::new(0, 1), observer.canMoveForward());
    println!("{}", observer.canMoveForward());
    release(Turtle::new(0, 1), &mut observer);
    Holder { turtle: Turtle::new(0, 1) }.report(observer.canMoveForward());
    let pair = (Turtle::new(0, 1), observer.canMoveForward());
    println!("{}", pair.1);
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: 'false\ntrue\ntrue\nfalse\nfalse\n',
    uncaughtException: undefined,
  });
});

test('uses Rust comparison traits and callback order in sorting and ordered collections', () => {
  const program = `use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Eq, PartialEq)]
struct P(i32);
impl Clone for P {
    fn clone(&self) -> Self { print!("C{} ", self.0); P(self.0) }
}
impl Ord for P {
    fn cmp(&self, other: &Self) -> Ordering {
        print!("O{}{} ", self.0, other.0);
        self.0.cmp(&other.0)
    }
}
impl PartialOrd for P {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        print!("P{}{} ", self.0, other.0);
        Some(self.0.cmp(&other.0))
    }
}

fn main() {
    let mut v = vec![P(2), P(1), P(3)];
    v.sort();
    println!("sort {:?}", v);
    println!("sorted {}", v.iter().is_sorted());
    println!("max {:?}", v.iter().max());
    let a = BTreeSet::from([P(1), P(3), P(5)]);
    println!("first {:?}", a);
    let b: BTreeSet<_> = [P(2), P(3), P(6)].into_iter().collect();
    println!("second {:?}", b);
    println!("union {:?}", &a | &b);
    println!("symmetric difference {:?}", &a ^ &b);
    let map: BTreeMap<_, _> = [(P(2), 1), (P(1), 2), (P(2), 3)].into_iter().collect();
    println!("map {:?}", map);
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout:
      'P12 P32 sort [P(1), P(2), P(3)]\nP12 P23 sorted true\nO12 O23 max Some(P(3))\nP31 P53 first {P(1), P(3), P(5)}\nP32 P63 second {P(2), P(3), P(6)}\nO12 C1 O32 C2 O33 C3 O56 C5 C6 union {P(1), P(2), P(3), P(5), P(6)}\nO12 C1 O32 C2 O33 O56 C5 C6 symmetric difference {P(1), P(2), P(5), P(6)}\nO12 O22 map {P(1): 2, P(2): 3}\n',
    uncaughtException: undefined,
  });
});

test('recognizes boolean and enum constants in exhaustive matches', () => {
  const program = `mod flags {
    const OFF: bool = false;
    pub const YES: bool = !OFF;
}
#[derive(PartialEq, Eq)]
enum Flag { Set(bool), Clear }
const SET: Flag = Flag::Set(flags::YES);
fn main() {
    match flags::YES {
        flags::YES => println!("yes"),
        false => println!("no"),
    }
    match Flag::Set(true) {
        SET => println!("set"),
        Flag::Set(false) => println!("unset"),
        Flag::Clear => println!("clear"),
    }
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: 'yes\nset\n',
    uncaughtException: undefined,
  });
});

test('clones closure captures and adapter state independently at the iterator position', () => {
  const program = `fn main() {
    let mut n = 0;
    let mut a = (0..3).map(move |_| { n += 1; n });
    let first = a.next();
    let b = a.clone();
    println!("{:?} {:?} {:?}", first, a.collect::<Vec<_>>(), b.collect::<Vec<_>>());

    let mut m = 0;
    let make = move || { m += 1; Some(m) };
    let a = std::iter::from_fn(make);
    let b = a.clone();
    println!("{:?} {:?}", a.take(2).collect::<Vec<_>>(), b.take(2).collect::<Vec<_>>());

    let mut n = 0;
    let a = (0..3).scan(0, move |state, _| { n += 1; *state += n; Some(*state) });
    let b = a.clone();
    println!("{:?} {:?}", a.collect::<Vec<_>>(), b.collect::<Vec<_>>());
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: 'Some(1) [2, 3] [2, 3]\n[1, 2] [1, 2]\n[1, 3, 6] [1, 3, 6]\n',
    uncaughtException: undefined,
  });
});

test('routes Rust Write trait output to the corresponding captured stream', () => {
  const program = String.raw`use std::io::{self, Write};
fn main() -> io::Result<()> {
    print!("prompt> ");
    io::stdout().flush()?;
    let stdout = io::stdout();
    let mut out = stdout.lock();
    writeln!(out, "{}", 42)?;
    out.write_all(&[0xe3, 0x81])?;
    out.write_all(&[0x82])?;
    assert_eq!(out.write(&[b'!'])?, 1);
    out.write_all(&[b'\n'])?;
    let mut err = io::stderr().lock();
    writeln!(&mut err, "error: {}", 1)?;
    err.flush()?;
    Ok(())
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: 'prompt> 42\nあ!\n',
    uncaughtException: undefined,
    stderr: 'error: 1\n',
  });
});

test('preserves String capacity when growing vectors, deques and heaps', () => {
  const program = `use std::collections::{BinaryHeap, VecDeque};

fn main() {
    let mut values = vec![String::with_capacity(20)];
    values.push(String::with_capacity(10));
    values.insert(1, String::with_capacity(15));
    let mut different = String::with_capacity(31);
    different.push_str("text");
    values.push(different);
    println!("{} {} {} {}", values[0].capacity(), values[1].capacity(), values[2].capacity(), values[3].capacity());
    let removed = values.remove(1);
    let mut suffix = vec![String::with_capacity(50)];
    values.append(&mut suffix);
    values.resize(6, String::with_capacity(40));
    println!("{} {} {} {} {}", removed.capacity(), values[1].capacity(), values[3].capacity(), values[4].capacity(), values[5].capacity());

    let mut deque = VecDeque::new();
    deque.push_back(String::with_capacity(25));
    deque.push_front(String::with_capacity(30));
    println!("{} {}", deque[0].capacity(), deque[1].capacity());

    let mut heap = BinaryHeap::new();
    heap.push(String::with_capacity(12));
    let mut top = String::with_capacity(35);
    top.push_str("top");
    heap.push(top);
    println!("{} {}", heap.pop().unwrap().capacity(), heap.pop().unwrap().capacity());
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: '20 15 10 31\n15 10 50 0 40\n30 25\n35 12\n',
    uncaughtException: undefined,
  });
});

test('uses partial order for range boundaries and total order for endpoint search', () => {
  const program = `use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};
#[derive(PartialEq, Eq)]
struct Key(i32);
impl PartialOrd for Key {
    fn partial_cmp(&self, rhs: &Self) -> Option<Ordering> {
        print!("P{}{}", self.0, rhs.0);
        Some(self.0.cmp(&rhs.0))
    }
    fn gt(&self, rhs: &Self) -> bool {
        print!("G{}{}", self.0, rhs.0);
        self.0 > rhs.0
    }
}
impl Ord for Key {
    fn cmp(&self, rhs: &Self) -> Ordering {
        print!("O{}{}", self.0, rhs.0);
        self.0.cmp(&rhs.0)
    }
}
fn main() {
    let map = BTreeMap::from([(Key(1), 1), (Key(2), 2), (Key(3), 3)]);
    println!(" map");
    let tail = map.range(Key(2)..=Key(3)).count();
    println!(" = {}", tail);
    let set = BTreeSet::from([Key(1), Key(2), Key(3)]);
    println!(" set");
    let tail = set.range(Key(2)..Key(3)).count();
    println!(" = {}", tail);
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: 'O21O32 map\nG23O21O22O32O33 = 2\nP21P32 set\nG23O21O22O32O33 = 1\n',
    uncaughtException: undefined,
  });
});

test('sorts cached keys with PartialOrd', () => {
  const program = `#[derive(Debug, Clone, PartialEq, Eq)]
struct P(i32, i32);
impl PartialOrd for P {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        print!("P");
        Some(self.0.cmp(&other.0).then(self.1.cmp(&other.1)))
    }
}
impl Ord for P {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        print!("O");
        self.0.cmp(&other.0).then(self.1.cmp(&other.1))
    }
}
fn main() {
    let mut v = vec![P(3, 0), P(1, 1), P(2, 2), P(1, 0), P(3, 1)];
    v.sort_by_cached_key(|p| p.clone());
    println!(" cached");
    println!("{:?}", v);
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: 'PPPPPPP cached\n[P(1, 0), P(1, 1), P(2, 2), P(3, 0), P(3, 1)]\n',
    uncaughtException: undefined,
  });
});

test('evaluates computed tuple and enum constants for pattern coverage', () => {
  const program = `#[derive(PartialEq, Eq)]
enum Flag { Set(bool), Clear }
const SET: Flag = {
    let flag = if 2 > 1 { Flag::Set(true) } else { Flag::Clear };
    flag
};
const YES: (bool, bool) = if true { (true, false) } else { (false, false) };
fn main() {
    match Flag::Set(true) {
        SET => println!("set"),
        Flag::Set(false) => println!("unset"),
        Flag::Clear => println!("clear"),
    }
    match (true, false) {
        YES => println!("yes"),
        (true, true) | (false, _) => println!("no"),
    }
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: 'set\nyes\n',
    uncaughtException: undefined,
  });
});

test('grows the buffer for format and Display-based String conversion as Rust does', () => {
  const program = `use std::fmt;

#[derive(Debug)]
struct Pair { left: i32, right: bool }
struct Custom;
impl fmt::Display for Custom {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("abcdefghijklmnopqrst")?;
        write!(f, "{}", 7)
    }
}
fn main() {
    let text = "x".repeat(26);
    let left = format!("{}{}", text, 1);
    let values = vec![1, 2, 3];
    let list = format!("{:?}", values);
    let pair = Pair { left: 1, right: true };
    let shape = format!("{pair:?}!");
    let float = 1.5f64.to_string();
    let own = Custom.to_string();
    let wide = format!("{:>21}", true);
    let literal = format!("こんにちは");
    let folded = format!("{}", "literal");
    let outside = format!("{} {}", "x".repeat(20), 7);
    println!("{} {} {} {} {} {} {} {} {}", left.capacity(), list.capacity(), shape.capacity(), float.capacity(), own.capacity(), wide.capacity(), literal.capacity(), folded.capacity(), outside.capacity());
    println!("{} {:?} {}", 12345.to_string().capacity(), &pair, true.to_string().capacity());
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: '52 16 32 8 40 32 15 7 40\n10 Pair { left: 1, right: true } 4\n',
    uncaughtException: undefined,
  });
});

test('numbers, escapes, and error values print as rustc prints them', () => {
  const program = `use std::num::IntErrorKind;
fn main() {
    let e = "300".parse::<u8>().unwrap_err();
    println!("{} {}", *e.kind() == IntErrorKind::PosOverflow, std::mem::size_of::<(u8, u32)>());
    println!("{:x?} {:?} {} {}", [255, 16], '\\u{301}', 1.00000005960464477539062500001f32, (1u64 << 60) as f32);
    println!("{:?} {:?}", "a\\rb\\r".lines().collect::<Vec<_>>(), String::from_utf8(vec![255]));
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: String.raw`true 8
[ff, 10] '\u{301}' 1.0000001 1152921500000000000
["a\rb\r"] Err(FromUtf8Error { bytes: [255], error: Utf8Error { valid_up_to: 0, error_len: Some(1) } })
`,
  });
});

test.each([
  ['a use after a move', '    let s1 = String::from("a");\n    let s2 = s1;\n    println!("{s1} {s2}");', 4],
  ['a move in an earlier iteration', '    let s = String::from("a");\n    for _ in 0..2 { let t = s; }', 3],
  ['an uninitialized variable', '    let x: i32;\n    if true {}\n    println!("{x}");', 4],
  ['a second assignment to an immutable variable', '    let x = 5;\n    println!("{x}");\n    x = 6;', 4],
  ['a mutable borrow of an immutable variable', '    let v = Vec::new();\n    v.push(1);', 3],
  [
    'a borrow that a later push conflicts with',
    '    let mut v = vec![1];\n    let first = &v[0];\n    v.push(2);\n    println!("{first}");',
    4,
  ],
  ['a move out of a Vec', '    let v = vec![String::new()];\n    let s = v[0];', 3],
  ['a non-exhaustive match', '    let n = 3;\n    match n { 1 => {} }', 3],
  ['arithmetic that always overflows', '    let x: u32 = 3;\n    let y = x - 5;', 3],
  ['arithmetic on an associated constant that overflows', '    let x = i32::MAX + 1;', 2],
  ['a Unicode escape in a byte literal', String.raw`    let byte = b'\u{41}';`, 2],
  ['a local Copy derive without Clone', '    #[derive(Copy)]\n    struct Number(i32);', 3],
  [
    'mutation during a live reference cast',
    '    let mut x = 1;\n    let borrowed = &x as &i32;\n    x = 2;\n    println!("{}", borrowed);',
    4,
  ],
  [
    'mutation during a live array-to-slice cast',
    '    let mut values = [1, 2];\n    let slice = &values as &[i32];\n    values[0] = 2;\n    println!("{}", slice[0]);',
    4,
  ],
  ['a non-ASCII byte literal', "    let byte = b'é';", 2],
  ['an out-of-range hex escape in a character literal', String.raw`    let char = '\xFF';`, 2],
  [
    'index made out of bounds by compound assignment',
    '    let a = [1, 2, 3];\n    let mut i = 2;\n    i += 1;\n    println!("{}", a[i]);',
    5,
  ],
  [
    'overflow in compound assignment',
    '    let mut x = u8::MAX;\n    x += 1;\n    let value = x;\n    println!("{}", value);',
    3,
  ],
  ['a literal out of its type', '    let x: u8 = 256;', 2],
  [
    'a borrow through a reference that a later push conflicts with',
    '    let mut v = vec![1];\n    let r = &mut v;\n    let first = &r[0];\n    r.push(2);\n    println!("{first}");',
    5,
  ],
  ['a method of signed integers on an unsigned one', '    let d = 3usize - 1;\n    println!("{}", d.abs());', 3],
  ['a derive whose field lacks the trait', '', 4, 'struct Id;\n#[derive(Debug)]\nstruct P {\n    id: Id,\n}'],
  [
    'a method of a trait that is not in scope',
    '    println!("{}", zoo::Dog.speak());',
    7,
    'mod zoo {\n    pub trait Speak { fn speak(&self) -> String; }\n    pub struct Dog;\n    impl Speak for Dog { fn speak(&self) -> String { "woof".into() } }\n}',
  ],
  [
    'a second call of an FnOnce closure',
    '    let v = vec![String::new()];\n    let f = move || v;\n    f();\n    f();',
    5,
  ],
  [
    'a trait method implemented with another return type',
    '',
    6,
    'trait Shape {\n    fn area(&self) -> f64;\n}\nstruct Sq;\nimpl Shape for Sq {\n    fn area(&self) -> i32 { 1 }\n}',
  ],
  [
    'a borrow that an if-let pattern binds, used after a push',
    '    let mut v = vec![1];\n    if let Some(x) = v.first() {\n        v.push(2);\n        println!("{x}");\n    }',
    4,
  ],
  [
    'a closure that borrows a variable a later push changes',
    '    let mut v = vec![1];\n    let c = || v.len();\n    v.push(2);\n    println!("{}", c());',
    4,
  ],
  ['a slice method whose argument reads the receiver', '    let mut v = vec![1, 2];\n    v.swap(0, v.len() - 1);', 3],
  [
    'a reference to a variable that goes out of scope',
    '    let r;\n    {\n        let x = 5;\n        r = &x;\n    }\n    println!("{r}");',
    5,
  ],
  [
    'the length of an iterator that does not know it',
    '    let s = String::from("hello");\n    println!("{}", s.chars().len());',
    3,
  ],
  [
    'an iterator of another type assigned to a variable',
    '    let v = vec![1, 2, 3];\n    let mut it = v.iter();\n    it = v.iter().skip(1);\n    println!("{:?}", it.next());',
    4,
  ],
  [
    'a closure called twice that a match in it moves a capture out of',
    '    let name = Some(String::from("a"));\n    let take = || match name {\n        Some(n) => n,\n        None => String::new(),\n    };\n    take();\n    take();',
    8,
  ],
  [
    'a closure that modifies through a captured &mut but is not declared mut',
    '    let mut v = vec![1];\n    let r = &mut v;\n    let c = || r.push(2);\n    c();',
    5,
  ],
  [
    'arithmetic on a mut variable assigned once that always overflows',
    '    let mut x: u8 = 255;\n    let y = x + 1;',
    3,
  ],
  [
    'arithmetic on a variable reassigned in the same basic block that always overflows',
    '    let mut x: i32 = 0;\n    x = i32::MAX;\n    let y = x + 1;',
    4,
  ],
  ['an associated function of a trait that is not in scope', '    let n = i32::from_str("4");', 2],
  [
    'a method that two traits in scope both have',
    '    Human.fly();',
    7,
    'trait Pilot { fn fly(&self); }\ntrait Wizard { fn fly(&self); }\nstruct Human;\nimpl Pilot for Human { fn fly(&self) {} }\nimpl Wizard for Human { fn fly(&self) {} }',
  ],
  [
    'arrays of different lengths compared with ==',
    '    let a = [1, 2];\n    let b = [1, 2, 3];\n    let c = a == b;',
    4,
  ],
  [
    "a parse error that ? cannot convert to the function's error type",
    '    let _ = f("1");',
    2,
    'fn f(s: &str) -> Result<f64, std::num::ParseIntError> {\n    let x: f64 = s.parse()?;\n    Ok(x)\n}',
  ],
  [
    "an operator's result whose type a closure's parameter decides only after it is used",
    '    let add = |a, b| a + b;\n    let x: u8 = add(200, 50);',
    2,
  ],
  ['a & pattern where the default binding mode borrows (edition 2024)', '    for (a, &b) in &vec![(1, &2)] {}', 2],
  [
    'a key that borrows from the element in sort_by_key',
    '    let mut v = vec![String::from("a")];\n    v.sort_by_key(|s| s);',
    3,
  ],
  ['trim_matches with a string pattern', '    let t = "xxaxx".trim_matches("xx");', 2],
  ['mismatched types', '    let x: i32 = "a";', 2],
])('rustc rejects %s before running', (_name, body, row, items = '') => {
  const execution = executeProgram('rust', rustMain(body, items));
  expect(execution.kind).toBe('compileError');
  expect(execution.kind === 'compileError' && execution.diagnostics[0].row + 1).toBe(row);
});

test('borrows end where non-lexical lifetimes end them, as rustc ends them', () => {
  const program = `fn first<'a, 'b>(x: &'a str, _y: &'b str) -> &'a str {
    x
}
struct P {
    name: String,
    age: u32,
}
fn main() {
    let mut v = vec![1, 2, 3];
    let r = &v[0];
    if v.len() > 5 { println!("{r}"); } else { v.push(4); }
    let words = vec![" a ", "b "];
    let trimmed: Vec<&str> = words.iter().map(|w| w.trim()).collect();
    let moved = words;
    let a = String::from("a");
    let mut b = String::from("b");
    let f = first(&a, &b);
    b.push('!');
    let p = P { name: String::from("n"), age: 3 };
    let P { name, age: _ } = p;
    let opt: Option<String> = None;
    if let Some(s) = opt { println!("{s}"); } else { println!("{:?}", opt); }
    let mut x = vec![1];
    let mut y = vec![2];
    std::mem::swap(&mut x, &mut y);
    println!("{:?} {:?} {:?} {} {} {} {} {:?} {:?}", v, trimmed, moved, f, b, name, p.age, x, y);
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: 'None\n[1, 2, 3, 4] ["a", "b"] [" a ", "b "] a b! n 3 [2] [1]\n',
    uncaughtException: undefined,
  });
});

test('iterators go backwards, clone, print, and have the types std gives them, as rustc runs them', () => {
  const program = `use std::iter::Peekable;
use std::str::Chars;
struct Lexer<'a> {
    chars: Peekable<Chars<'a>>,
}
fn main() {
    let v = vec![1, 2, 3, 4, 5];
    let a: Vec<_> = v.iter().take(2).rev().collect();
    let b: Vec<_> = (0..10).step_by(3).rev().collect();
    let c: Vec<_> = v.iter().zip(["a", "b", "c"].iter()).rev().collect();
    let mut it = v.iter();
    it.next();
    let copy = it.clone();
    it.next();
    let d: Vec<i32> = vec![[1, 2], [3, 4]].into_iter().flatten().collect();
    let mut lexer = Lexer { chars: "xy".chars().peekable() };
    let first = lexer.chars.peek().copied();
    println!("{:?} {:?} {:?} {} {} {:?} {:?}", a, b, c, copy.len(), it.len(), d, first);
    println!("{:?} {:?}", v.iter().skip(3), "hi".chars().rev());
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: `[2, 1] [9, 6, 3, 0] [(3, "c"), (2, "b"), (1, "a")] 4 3 [1, 2, 3, 4] Some('x')
Skip { iter: Iter([1, 2, 3, 4, 5]), n: 3 } Rev { iter: Chars(['h', 'i']) }
`,
    uncaughtException: undefined,
  });
});

test('values coerce where rustc coerces them: branches, elements, arguments, and casts', () => {
  const program = `use std::fmt::Display;
fn get(s: &String) -> Result<&str, String> {
    Ok(s)
}
fn make(c: bool) -> Box<dyn Display> {
    if c { Box::new(1) } else { Box::new("two") }
}
fn main() {
    let owned = String::from("o");
    let a = if owned.is_empty() { "lit" } else { &owned };
    let b = match owned.len() {
        1 => &owned,
        _ => "other",
    };
    let c = [&owned, "x"];
    let d: Option<&str> = Some(&owned);
    let e: Option<Box<dyn Display>> = Some(Box::new(2.5));
    let f = Box::new(3) as Box<dyn Display>;
    println!("{} {} {:?} {:?} {:?} {} {} {} {}", a, b, c, d, get(&owned), e.unwrap(), f, make(true), make(false));
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: 'o o ["o", "x"] Some("o") Ok("o") 2.5 3 1 two\n',
    uncaughtException: undefined,
  });
});

test('closures are Copy or Clone as what they capture is, and copies keep their own state', () => {
  const program = `fn twice<F: Fn() -> i32>(f: F) -> i32 {
    f() + f()
}
fn main() {
    let k = 5;
    let f = || k * 2;
    let s = String::from("ab");
    let g = move || s.len();
    let h = g.clone();
    let mut n = 0;
    let mut c = move || {
        n += 1;
        n
    };
    let mut d = c;
    println!("{} {} {} {} {} {} {} {}", twice(f), twice(f), g(), h(), c(), c(), d(), n);
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: '20 20 2 2 1 2 1 0\n',
    uncaughtException: undefined,
  });
});

test('std traits apply as std implements them: generic iterators, blanket impls, Rhs, and the impl a number fits', () => {
  const program = `use std::collections::{HashMap, HashSet};
use std::fmt::Display;
use std::str::FromStr;
trait Describe {
    fn describe(&self) -> String;
}
impl Describe for u8 {
    fn describe(&self) -> String { format!("u8 {}", self) }
}
struct Meters(i32);
impl PartialEq<i32> for Meters {
    fn eq(&self, other: &i32) -> bool { self.0 == *other }
}
fn largest<I>(it: I) -> Option<I::Item> where I: Iterator, I::Item: Ord { it.max() }
fn total<I: IntoIterator<Item = u32>>(items: I) -> u32 { items.into_iter().sum() }
fn evens(n: u32) -> impl Iterator<Item = u32> { (0..n).filter(|x| x % 2 == 0) }
fn show<T: Display>(t: T) -> String { t.to_string() }
fn describe<T: Describe>(t: T) -> String { t.describe() }
fn main() {
    println!("{:?} {} {:?}", largest("bca".chars()), total(evens(7)), evens(5).collect::<Vec<_>>());
    println!("{} {} {}", show(4), describe(5), Meters(5) == 5);
    println!("{:?} {:?}", f64::from_str("1.5"), vec![[1, 2], [3, 4]].concat());
    let a: HashSet<i32> = [1, 2].into_iter().collect();
    let b: HashSet<i32> = [2, 3].into_iter().collect();
    let mut both: Vec<i32> = (&a & &b).into_iter().collect();
    both.sort();
    println!("{:?} {} {}", both, vec![1, 2] == [1, 2], &vec![1, 2][..] == [1, 2]);
    let mut m: HashMap<&str, i32> = HashMap::new();
    m.insert("k", 1);
    println!("{:?}", m.entry("k"));
    println!("{:?}", m.entry("z"));
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout:
      "Some('c') 12 [0, 2, 4]\n4 u8 5 true\nOk(1.5) [1, 2, 3, 4]\n[2] true true\n" +
      'Entry(OccupiedEntry { key: "k", value: 1, .. })\nEntry(VacantEntry("z"))\n',
    uncaughtException: undefined,
  });
});

test('sorts, max_by, dedup_by_key, and zip call closures in the order and number std does', () => {
  const program = `fn main() {
    let mut v: Vec<i32> = (0..40).map(|i| (i * 37) % 41).collect();
    let mut count = 0;
    v.sort_by(|a, b| { count += 1; a.cmp(b) });
    let mut w: Vec<(i32, i32)> = (0..30).map(|i| ((i * 7) % 3, i)).collect();
    w.sort_unstable_by_key(|p| p.0);
    println!("{} {:?}", count, w.iter().map(|p| p.1).collect::<Vec<_>>());
    let mut small = vec![3, 1, 2];
    small.sort_by(|a, b| { print!("{}{} ", a, b); a.cmp(b) });
    let m = [3, 1, 2].iter().max_by(|a, b| { print!("{}{} ", a, b); a.cmp(b) });
    let mut d = vec![1, 1, 2, 3, 3];
    d.dedup_by_key(|x| { print!("k{} ", x); *x / 2 });
    let z: Vec<(i32, i32)> = [1, 2, 3].iter().map(|x| { print!("a{} ", x); *x }).zip([10].iter().copied()).collect();
    println!("{:?} {:?} {:?}", m, d, z);
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout:
      '233 [0, 6, 9, 3, 12, 15, 21, 24, 18, 27, 4, 7, 1, 10, 13, 19, 22, 16, 25, 28, 5, 2, 8, 11, 14, 20, 17, 23, 26, 29]\n' +
      '13 23 21 31 32 k1 k1 k2 k1 k3 k2 k3 k2 a1 Some(3) [1, 2] [(1, 10)]\n',
    uncaughtException: undefined,
  });
});

test('capacities grow and sizes lay out as std and rustc make them', () => {
  const program = `use std::collections::HashMap;
use std::mem::size_of;
enum Message { Quit, Move { x: i32, y: i32 }, Write(String) }
fn main() {
    let mut v: Vec<i32> = Vec::new();
    for i in 0..5 { v.push(i); print!("{} ", v.capacity()); }
    let evens: Vec<i32> = (0..10).filter(|x| x % 2 == 0).collect();
    let mut s = String::with_capacity(3);
    s.push_str("abcd");
    let mut m: HashMap<i32, i32> = HashMap::new();
    m.insert(1, 1);
    println!("{} {} {}", evens.capacity(), s.capacity(), m.capacity());
    println!("{} {} {} {}", size_of::<Option<bool>>(), size_of::<Option<String>>(), size_of::<Message>(), size_of::<(u8, u32, u8)>());
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: '4 4 4 4 8 8 8 3\n1 24 24 8\n',
    uncaughtException: undefined,
  });
});

test('closures, sums of Results, arrays, ranges, moved Strings, and zips run as rustc runs them', () => {
  const program = `fn make() -> String {
    let mut t = String::with_capacity(9);
    t.push('a');
    t
}
fn main() {
    let square = |x| x * x;
    let w: Vec<i32> = vec![1, 2, 3].iter().map(square).collect();
    let s: Result<i32, String> = vec![Ok(1), Ok(2)].into_iter().sum();
    let a = [1, 2, 3].map(|x| x * 10);
    let names = vec![make()];
    let z: Vec<(i32, i32)> = [1, 2, 3].iter().map(|&x| { print!("L{} ", x); x }).zip([7, 8].iter().map(|&x| x).take(1)).collect();
    println!("{:?} {:?} {:?} {} {} {:?}", w, s, a, (1..4).eq(vec![1, 2, 3]), names[0].capacity(), z);
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: 'L1 [1, 4, 9] Ok(3) [10, 20, 30] true 9 [(1, 7)]\n',
    uncaughtException: undefined,
  });
});

test('iterators print the state rustc prints with {:?}, also when cloned', () => {
  const program = `use std::collections::{BTreeSet, VecDeque};
fn main() {
    let mut s = "a,b".split(',');
    s.next();
    println!("{:?}", s);
    println!("{:?}", "xxa".split("xx"));
    let mut d: VecDeque<i32> = VecDeque::with_capacity(2);
    d.push_back(1);
    d.push_front(0);
    println!("{:?}", d.iter());
    let a: BTreeSet<i32> = [1, 2].into();
    let b: BTreeSet<i32> = [2, 3].into();
    println!("{:?}", a.union(&b));
    let mut c = [1, 2].iter().cycle().skip_while(|&&x| x < 2);
    c.next();
    println!("{:?}", c.clone());
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: `Split(SplitInternal { start: 2, end: 3, matcher: CharSearcher { haystack: "a,b", finger: 2, finger_back: 3, needle: ',', utf8_size: 1, utf8_encoded: [44, 0, 0, 0] }, allow_trailing_empty: true, finished: false })
Split(SplitInternal { start: 0, end: 3, matcher: StrSearcher { haystack: "xxa", needle: "xx", searcher: TwoWay(TwoWaySearcher { crit_pos: 0, crit_pos_back: 2, period: 1, byteset: 72057594037927936, position: 0, end: 3, memory: 0, memory_back: 2 }) }, allow_trailing_empty: true, finished: false })
Iter([0], [1])
Union(MergeIterInner(Iter([1, 2]), Iter([2, 3]), None))
SkipWhile { iter: Cycle { orig: Iter([1, 2]), iter: Iter([]) }, flag: true }
`,
    uncaughtException: undefined,
  });
});

test.each([
  ['range patterns (stage C)', '    match 3 { 1..=5 => {}, _ => {} }'],
  ['attributes on tuple elements (stage C)', '    let tuple = (#[cfg(any())] 1, 2);'],
  ['an unavailable string method', '    let matches = "abcabc".rmatch_indices("bc");'],
  ['an unavailable slice method reached through Vec', '    let groups = vec![1, 1, 2].chunk_by(|a, b| a == b);'],
  ['threads (stage D)', '    std::thread::spawn(|| {});'],
  ['standard input (stage D)', '    let mut s = String::new();\n    std::io::stdin().read_line(&mut s).unwrap();'],
  [
    'associated output types of operator bounds (stage C)',
    '',
    'use std::ops::Add; fn plus<T: Add<Output = T>>(a: T, b: T) -> T { a + b }',
  ],
  ['generic assignment operators (stage C)', '', 'fn inc<T: std::ops::AddAssign + Copy>(mut a: T, b: T) { a += b; }'],
  ['operator overloading (stage C)', '', 'struct P;\nimpl std::ops::Add for P { fn add(self, o: P) -> P { o } }'],
])('%s are unavailable', (_name, body, items = '') => {
  const execution = executeProgram('rust', rustMain(body, items));
  expect(execution.kind).toBe('compileError');
  expect(execution.kind === 'compileError' && execution.diagnostics[0].message).toMatch(
    /この採点環境では使えません(?:）)?。$/
  );
});

test.each(['(0..2_000_000).nth(1_000_000)', '(0..2_000_000).take(1).next_back()'])(
  'iterator traversal counts skipped items against the operation limit: %s',
  (expression) => {
    expect(executeProgram('rust', rustMain(`    let item = ${expression};`))).toEqual({
      kind: 'limitExceeded',
      limit: 'operations',
    });
  }
);

test('nested loops with stable ownership states compile and run within the operation budget', () => {
  const body = `${'for _ in 0..1 {'.repeat(18)}
    println!("done");
    ${'}'.repeat(18)}`;
  expect(executeProgram('rust', rustMain(body))).toMatchObject({
    kind: 'executed',
    stdout: 'done\n',
    uncaughtException: undefined,
  });
});

test('an endless loop stops at the operation limit', () => {
  expect(executeProgram('rust', rustMain('    let mut i: u64 = 0;\n    loop { i = i.wrapping_add(1); }'))).toEqual({
    kind: 'limitExceeded',
    limit: 'operations',
  });
});

test.each([
  ['a doubled String', 'let mut s = String::from("ab"); for _ in 0..40 { s = s.clone() + &s; }'],
  ['a String written to', 'let mut s = String::from("ab"); for _ in 0..40 { let t = s.clone(); s.push_str(&t); }'],
  ['a formatted String', 'let mut s = String::from("ab"); for _ in 0..40 { s = format!("{s}{s}"); }'],
  ['a wide format', 'let w = 100_000_000; let s = format!("{:>w$}", 1);'],
  ['a precise float', 'println!("{:.100000000}", 1.0);'],
  ['nested Vecs', 'let v = vec![vec![0u8; 10_000]; 10_000];'],
  ['nested arrays', 'let a = [[0u8; 10_000]; 10_000];'],
  ['default values for nested arrays', 'let a: [[[[i32; 32]; 32]; 32]; 32] = Default::default();'],
  ['materialized UTF-8 bytes', 'let s = "é".repeat(300_000); let _a = s.as_bytes(); let _b = s.bytes();'],
  ['a concatenated Vec', 'let mut v = vec![1u8]; for _ in 0..40 { v = [v.clone(), v.clone()].concat(); }'],
  ['clones of a Vec', 'let v = vec![0u8; 900_000]; let mut w = Vec::new(); for _ in 0..100 { w.push(v.clone()); }'],
])('%s stops at the memory limit', (_name, body) => {
  const execution = executeProgram('rust', rustMain(`    ${body}`));
  expect(execution.kind === 'executed' && execution.uncaughtException).toMatch(
    /^memory allocation of \d+ bytes failed\n/
  );
});

test.each([
  ['replacements', 'let s = "ab".repeat(400_000); for _ in 0..100 { let _ = s.replace("a", "c"); }'],
  ['case mappings', 'let s = "é".repeat(900_000); for _ in 0..100 { let _ = s.to_uppercase(); }'],
  ['clones of a String', 'let s = "a".repeat(900_000); for _ in 0..1000 { let _ = s.clone(); }'],
])('%s of long strings stop at the operation limit', (_name, body) => {
  expect(executeProgram('rust', rustMain(`    ${body}`))).toEqual({ kind: 'limitExceeded', limit: 'operations' });
});

test('capacities that overflow panic as std and hashbrown do', () => {
  const vec = executeProgram(
    'rust',
    rustMain('    let s = String::with_capacity(usize::MAX);\n    println!("{}", s.len());')
  );
  expect(vec).toMatchObject({
    kind: 'executed',
    uncaughtException: `thread 'main' (1) panicked at /rustc/58cf8f9c35b355199727627d07ae34a4e2846d67/library/alloc/src/raw_vec/mod.rs:28:5:
capacity overflow
note: run with \`RUST_BACKTRACE=1\` environment variable to display a backtrace`,
  });
  const table = executeProgram(
    'rust',
    rustMain(
      '    let m: std::collections::HashMap<u8, u8> = std::collections::HashMap::with_capacity(usize::MAX);\n    println!("{}", m.len());'
    )
  );
  expect(table).toMatchObject({
    kind: 'executed',
    uncaughtException: `thread 'main' (1) panicked at /rust/deps/hashbrown-0.17.1/src/raw.rs:36:40:
Hash table capacity overflow
note: run with \`RUST_BACKTRACE=1\` environment variable to display a backtrace`,
  });
});
