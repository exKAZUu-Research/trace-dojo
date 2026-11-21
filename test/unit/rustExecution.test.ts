import { expect, test } from 'vitest';

import { executeProgram, traceProgram } from '../../src/interpreter/program';

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
    let positive = f64::NAN;
    let negative = positive.copysign(-1.0);
    let negative32 = f32::NAN.copysign(-1.0);
    println!("{} {} {} {}", positive.is_sign_positive(), negative.is_sign_negative(), 1.0_f64.copysign(negative), 1.0_f32.copysign(negative32));
    println!("{} {} {}", negative32.is_sign_negative(), negative32.copysign(1.0).is_sign_positive(), (-0.0_f64).is_sign_negative());
    let parsed = "-NaN".parse::<f64>().unwrap();
    let parsed32 = "-nAn".parse::<f32>().unwrap();
    println!("{} {} {} {}", parsed.is_sign_negative(), 1.0_f64.copysign(parsed), parsed32.is_sign_negative(), 1.0_f32.copysign(parsed32));
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
true true -1 -1
true true true
true -1 true -1
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
struct S { pair: (bool, bool) }
const STRUCT_VALUE: (bool, bool) = {
    let S { pair: (first, second) } = S { pair: (false, true) };
    (first, second)
};
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
    match (false, true) {
        STRUCT_VALUE => println!("struct"),
        (false, false) | (true, _) => println!("no"),
    }
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: 'set\nyes\nstruct\n',
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

test('resolves formatting trait methods through a glob re-export', () => {
  const program = `mod traits { pub use std::fmt::Write as Output; }
use traits::*;
fn append<T: Output>(dest: &mut T) {
    Output::write_str(dest, "hi").unwrap();
    dest.write_char('!').unwrap();
}
fn main() {
    let mut s = String::new();
    append(&mut s);
    write!(&mut s, " {}", 7).unwrap();
    println!("{} {}", s, s.capacity());
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: 'hi! 7 8\n',
    uncaughtException: undefined,
  });
});

test('evaluates each pattern source exactly once', () => {
  const program = `struct S { value: String }
fn make() -> S {
    println!("make");
    S { value: String::from("hi") }
}
fn main() {
    match make().value {
        text => println!("match {}", text),
    }
    if let text = make().value {
        println!("if {}", text);
    }
    while let text = make().value {
        println!("while {}", text);
        break;
    }
    let S { value: text } = make();
    println!("let {}", text);
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: 'make\nmatch hi\nmake\nif hi\nmake\nwhile hi\nmake\nlet hi\n',
    uncaughtException: undefined,
  });
});

test('keeps unbound Turtle temporaries alive through matches and slice bounds', () => {
  const program = `fn bound(observer: &mut Turtle) -> usize {
    println!("{}", observer.canMoveForward());
    0
}
fn main() {
    let mut observer = Turtle::new(0, 0);
    match Some(Turtle::new(0, 1)) {
        Some(_) => println!("{}", observer.canMoveForward()),
        None => (),
    }
    println!("{}", observer.canMoveForward());
    {
        let slice = &vec![Turtle::new(0, 1)][bound(&mut observer)..];
        println!("{}", slice.len());
    }
    println!("{}", observer.canMoveForward());
    {
        let slice = &[Turtle::new(0, 1)][bound(&mut observer)..];
        println!("{}", slice.len());
    }
    println!("{}", observer.canMoveForward());
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: 'false\ntrue\nfalse\n1\ntrue\nfalse\n1\ntrue\n',
    uncaughtException: undefined,
  });
});

test('instantiates associated constants with concrete impl arguments', () => {
  const program = `use std::mem::size_of;
struct Wrapper<T>(T);
impl<T> Wrapper<T> {
    const SIZE: usize = size_of::<T>();
    const NEXT: usize = Self::SIZE + 1;
    const SELF_SIZE: usize = size_of::<Self>();
}
fn sizes<T>() -> (usize, usize) {
    (Wrapper::<T>::SIZE, Wrapper::<T>::NEXT)
}
fn main() {
    println!("{:?} {:?}", sizes::<i32>(), sizes::<i64>());
    println!("{} {}", Wrapper::<i32>::SELF_SIZE, Wrapper::<i64>::SELF_SIZE);
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: '(4, 5) (8, 9)\n4 8\n',
    uncaughtException: undefined,
  });
});

test('clones concrete captures in generic iterator constructors', () => {
  const program = `trait Counter { fn bump(&mut self) -> i32; }
impl Counter for Vec<i32> {
    fn bump(&mut self) -> i32 {
        self[0] += 1;
        self[0]
    }
}
fn check<T: Clone + Counter>(seed: T) {
    let mut x = seed.clone();
    let make = (0..2).map(move |_| x.bump());
    let other = make.clone();
    println!("{:?} {:?}", make.collect::<Vec<_>>(), other.collect::<Vec<_>>());
    let mut x = seed;
    let make = std::iter::from_fn(move || Some(x.bump()));
    let other = make.clone();
    println!("{:?} {:?}", make.take(2).collect::<Vec<_>>(), other.take(2).collect::<Vec<_>>());
}
fn main() { check(vec![1]); }`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: '[2, 3] [2, 3]\n[2, 3] [2, 3]\n',
    uncaughtException: undefined,
  });
});

test('dispatches Rust ordering methods by relation and right-hand type', () => {
  const program = `use std::cmp::Ordering;
#[derive(Debug, Clone, PartialEq, Eq)]
struct Key(i32);
impl PartialOrd for Key {
    fn partial_cmp(&self, rhs: &Self) -> Option<Ordering> { print!("P"); Some(self.0.cmp(&rhs.0)) }
    fn lt(&self, rhs: &Self) -> bool { print!("L"); self.0 < rhs.0 }
    fn le(&self, rhs: &Self) -> bool { print!("E"); self.0 <= rhs.0 }
    fn gt(&self, rhs: &Self) -> bool { print!("G"); self.0 > rhs.0 }
    fn ge(&self, rhs: &Self) -> bool { print!("H"); self.0 >= rhs.0 }
}
impl Ord for Key {
    fn cmp(&self, rhs: &Self) -> Ordering { print!("O"); self.0.cmp(&rhs.0) }
}
impl PartialEq<i32> for Key {
    fn eq(&self, rhs: &i32) -> bool { self.0 == *rhs }
}
impl PartialOrd<i32> for Key {
    fn partial_cmp(&self, rhs: &i32) -> Option<Ordering> { print!("I"); self.0.partial_cmp(rhs) }
    fn lt(&self, rhs: &i32) -> bool { print!("N"); self.0 < *rhs }
}
fn check<T: PartialOrd<T>>(a: T, b: T) -> bool { a <= b }
fn check_number(a: impl PartialOrd<i32>) -> bool { a < 3 }
fn main() {
    println!(" {} {} {} {}", Key(1) < Key(2), Key(1) <= Key(2), Key(1) > Key(2), Key(1) >= Key(2));
    println!(" {} {}", (Key(1)..Key(3)).contains(&Key(2)), (Key(1)..=Key(3)).is_empty());
    println!(" {} {}", check(Key(1), Key(2)), check_number(Key(2)));
    println!(" {:?} {:?}", Key(1).partial_cmp(&2), Key(1).partial_cmp(&Key(2)));
    let mut values = [Key(2), Key(1)];
    values.sort();
    println!(" {:?}", values);
    let mut empty = 1..=1;
    println!("{:?} {} {}", empty.next(), empty.contains(&1), empty.is_empty());
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout:
      'LEGH true true false false\nELE true false\nEN true true\nIP Some(Less) Some(Less)\nL [Key(1), Key(2)]\nSome(1) false true\n',
    uncaughtException: undefined,
  });
});

test('preserves Rust tree comparisons across splits, bulk construction and deletion', () => {
  const program = `use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};
#[derive(Debug, Eq)]
struct Key(i32, bool);
impl PartialEq for Key {
    fn eq(&self, rhs: &Self) -> bool { self.0 == rhs.0 }
}
impl PartialOrd for Key {
    fn partial_cmp(&self, rhs: &Key) -> Option<Ordering> { Some(self.0.cmp(&rhs.0)) }
}
impl Ord for Key {
    fn cmp(&self, rhs: &Key) -> Ordering {
        if self.1 { print!("{}>{} ", self.0, rhs.0); }
        self.0.cmp(&rhs.0)
    }
}
fn main() {
    let mut set = BTreeSet::new();
    let mut map = BTreeMap::new();
    for n in 0..12 { set.insert(Key(n, false)); map.insert(Key(n, false), n); }
    println!("insert");
    println!("set {}", set.contains(&Key(11, true)));
    println!("map {:?}", map.get(&Key(11, true)));
    println!("range {:?}", set.range(Key(4, true)..=Key(8, true)).map(|key| key.0).collect::<Vec<_>>());
    for n in [6, 2, 11] { set.remove(&Key(n, true)); }
    println!("remove {:?}", set.iter().map(|key|key.0).collect::<Vec<_>>());
    println!("look {}", set.contains(&Key(8, true)));
    let bulk: BTreeSet<_> = (0..30).map(|x| Key(x, false)).collect();
    println!("bulk {}", bulk.contains(&Key(27, true)));
    let bulk_map: BTreeMap<_, _> = (0..30).map(|x| (Key(x, false), x)).collect();
    println!("bulk map {:?}", bulk_map.get(&Key(27, true)));
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout:
      'insert\n11>6 11>7 11>8 11>9 11>10 11>11 set true\n11>6 11>7 11>8 11>9 11>10 11>11 map Some(11)\n4>6 8>6 4>0 4>1 4>2 4>3 4>4 8>7 8>8 range [4, 5, 6, 7, 8]\n6>6 2>5 2>0 2>1 2>2 11>0 11>1 11>3 11>4 11>5 11>7 11>8 11>9 11>10 11>11 remove [0, 1, 3, 4, 5, 7, 8, 9, 10]\n8>0 8>1 8>3 8>4 8>5 8>7 8>8 look true\n27>11 27>23 27>24 27>25 27>26 27>27 bulk true\n27>11 27>23 27>24 27>25 27>26 27>27 bulk map Some(27)\n',
    uncaughtException: undefined,
  });
});

test('keeps String capacity with elements through slice reordering', () => {
  const program = `fn make(text: &str, reserve: usize) -> String {
    let mut s = String::with_capacity(reserve);
    s.push_str(text);
    s
}
fn capacities(v: &[String]) {
    let mut out = Vec::new();
    for i in 0..v.len() { out.push(v[i].capacity()); }
    println!("{:?}", out);
}
fn main() {
    let mut v = vec![make("bb", 22)];
    v.push(make("cc", 33));
    v.push(make("a", 11));
    capacities(&v);
    v[..2].swap(0, 1);
    capacities(&v);
    v.reverse();
    capacities(&v);
    v.rotate_left(1);
    capacities(&v);
    v.sort_unstable();
    capacities(&v);
    v.sort_by_cached_key(|s| 9 - s.len());
    capacities(&v);
    let mut equal = vec![make("a", 10)];
    equal.push(make("a", 30));
    equal.reverse();
    capacities(&equal);
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: '[22, 33, 11]\n[33, 22, 11]\n[11, 22, 33]\n[22, 33, 11]\n[11, 22, 33]\n[22, 33, 11]\n[30, 10]\n',
    uncaughtException: undefined,
  });
});

test.each([
  ['/', 'x - 2'],
  ['%', 'x'],
  ['<<', 'x - 128'],
  ['>>', 'x'],
])('checked compound %s reloads the left operand after its assertion', (operator, divisor) => {
  const prefix = 'let mut x: i32 = 8;';
  const print = `println!("{}", 8 / (${divisor}));`;
  expect(executeProgram('rust', rustMain(`${prefix} x ${operator}= 4; ${print}`))).toMatchObject({
    kind: 'executed',
    uncaughtException: expect.stringContaining('attempt to divide by zero'),
  });
  expect(executeProgram('rust', rustMain(`${prefix} x = x ${operator} 4; ${print}`)).kind).toBe('compileError');
});

test.each([
  ['left', '[1, 2].into()', 3, 3137],
  ['right', 'VecDeque::new()', 1, 3180],
])('VecDeque rotate_%s rejects amounts larger than its length', (direction, initial, amount, line) => {
  const program = rustMain(
    `let mut q: VecDeque<i32> = ${initial}; q.rotate_${direction}(${amount}); println!("rotated");`,
    'use std::collections::VecDeque;'
  );
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: '',
    uncaughtException: expect.stringContaining(
      `alloc/src/collections/vec_deque/mod.rs:${line}:9:\nassertion failed: n <= self.len()`
    ),
  });
});

test.each([
  ['PartialOrd<i64>', '1', { kind: 'executed', stdout: '8\n' }],
  ['PartialOrd<String>', '1', { kind: 'compileError' }],
  ['PartialEq<String>', '1.0', { kind: 'compileError' }],
])('checks numeric literal bounds against %s', (bound, argument, expected) => {
  const program = `fn number_size<T: ${bound}>(_: T) -> usize { std::mem::size_of::<T>() }
fn main() { println!("{}", number_size(${argument})); }`;
  expect(executeProgram('rust', program)).toMatchObject(expected);
});

test('derives PartialOrd and Ord with the default right-hand type', () => {
  const program = `#[derive(Debug, Clone, PartialEq, PartialOrd)]
enum Maybe<T> { Value(T), Absent }
#[derive(Debug, PartialEq, Eq, PartialOrd, Ord)]
struct Key { value: i32 }
fn main() {
    println!("{} {}", Maybe::Value(1.0) < Maybe::Value(2.0), Maybe::Value(3) < Maybe::Absent);
    let mut keys = [Key { value: 3 }, Key { value: 2 }];
    keys.sort();
    println!("{:?}", keys);
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: 'true true\n[Key { value: 2 }, Key { value: 3 }]\n',
    uncaughtException: undefined,
  });
});

test('copies slice fill inputs before moving the original into the final slot', () => {
  const program = `#[derive(Debug)]
struct Token(i32);
impl Clone for Token {
    fn clone(&self) -> Self {
        print!("clone ");
        Token(self.0 + 10)
    }
}
fn main() {
    let mut one = [Token(0)];
    one.fill(Token(1));
    println!("{:?}", one);
    let mut three = [Token(0), Token(0), Token(0)];
    three.fill(Token(2));
    println!("{:?}", three);
    let mut none: [Token; 0] = [];
    none.fill(Token(3));
    println!("{:?}", none);
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: '[Token(1)]\nclone clone [Token(12), Token(12), Token(2)]\n[]\n',
    uncaughtException: undefined,
  });
});

test('preserves Unicode whitespace following Rust string continuations', () => {
  const program = String.raw`fn main() {
    println!("{:?}", "left\
         right");
    println!("{:?}", "left\

        right");
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: '"left\\u{a0}right"\n"leftright"\n',
    uncaughtException: undefined,
  });
});

test('resolves anonymous Rust trait imports through public globs', () => {
  const program = `mod traits { pub use std::fmt::Write as _; }
mod reexports { pub use super::traits::*; }
use reexports::*;
fn main() {
    let mut s = String::new();
    write!(&mut s, "hi").unwrap();
    s.write_char('!').unwrap();
    println!("{}", s);
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: 'hi!\n',
    uncaughtException: undefined,
  });
});

test('captures values consumed by Rust macros in FnOnce closures', () => {
  const program = `fn main() {
    let text = String::from("hi");
    let debug = || { dbg!(text); };
    debug();
    let text = String::from("vector");
    let vector = || { let values = vec![text; 1]; println!("{:?}", values); };
    vector();
    let input = Some(String::from("value"));
    let matches = || matches!(input, Some(_value));
    println!("{}", matches());
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: '["vector"]\ntrue\n',
    uncaughtException: undefined,
    stderr: expect.stringContaining('text = "hi"'),
  });
});

test.each([
  'fn run<F: FnMut()>(callback: F) { callback(); } fn main() {}',
  'fn main() { let callback: Box<dyn FnMut()> = Box::new(|| ()); callback(); }',
  'struct H { callback: Box<dyn FnMut()> } fn main() { let h = H { callback: Box::new(|| ()) }; (h.callback)(); }',
])('requires a mutable place to call FnMut', (program) => {
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'compileError',
    diagnostics: [expect.objectContaining({ message: expect.stringContaining('mut') })],
  });
});

test('calls FnMut through an existing mutable reference', () => {
  const program = `fn run<F: FnMut()>(callback: &mut F) {
    callback();
}
fn main() {
    let mut count = 0;
    let mut f = || count += 1;
    run(&mut f);
    run(&mut f);
    println!("{}", count);
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: '2\n',
    uncaughtException: undefined,
  });
});

test('drops bound loop values and retains unused argument parts at Rust scope boundaries', () => {
  const program = `fn wildcard(_: Turtle, observer: &Turtle) {
    println!("argument {}", observer.canMoveForward());
}
fn partial((taken, _): (Turtle, Turtle), first: &Turtle, second: &Turtle) {
    drop(taken);
    println!("partial {} {}", first.canMoveForward(), second.canMoveForward());
}
fn main() {
    let observer = Turtle::new(0, 0);
    let second_observer = Turtle::new(2, 0);
    wildcard(Turtle::new(0, 1), &observer);
    println!("returned {}", observer.canMoveForward());
    partial((Turtle::new(0, 1), Turtle::new(2, 1)), &observer, &second_observer);
    println!("returned {}", second_observer.canMoveForward());
    let values = vec![Turtle::new(0, 1), Turtle::new(4, 4)];
    for _item in values.into_iter().map(|t| { println!("next {}", observer.canMoveForward()); t }) {
        continue;
    }
    println!("done {}", observer.canMoveForward());
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: 'argument false\nreturned true\npartial true false\nreturned true\nnext false\nnext true\ndone true\n',
    uncaughtException: undefined,
  });
});

test.each([
  [
    'for',
    `fn main() {
    let mut last = None;
    for i in 0..3 {
        last = Some(&i);
    }
    println!("{:?}", last);
}`,
  ],
  [
    'while',
    `fn main() {
    let mut option = Some(1);
    let mut last = &0;
    while let Some(value) = option {
        last = &value;
        option = None;
    }
    println!("{}", last);
}`,
  ],
  [
    'if',
    `fn main() {
    let last;
    if let Some(value) = Some(1) {
        last = &value;
    } else { return; }
    println!("{}", last);
}`,
  ],
  [
    'arm',
    `fn main() {
    let last = match Some(1) {
        Some(value) => &value,
        None => return,
    };
    println!("{}", last);
}`,
  ],
  [
    'break',
    `fn main() {
    let mut last = &0;
    for value in 0..3 { last = &value; break; }
    println!("{}", last);
  }`,
  ],
])('rejects a Rust borrow that escapes its %s pattern scope', (_scope, program) => {
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'compileError',
    diagnostics: [expect.objectContaining({ message: expect.stringMatching(/スコープの外|参照を外へ持ち出せません/) })],
  });
});

test.each([
  [
    'parameter',
    `fn receive(callback: Box<dyn Fn() -> i32>) { println!("{}", callback()); }
fn main() {
    let local = 5;
    receive(Box::new(|| local));
}`,
  ],
  [
    'return',
    `fn make<'a>(value: &'a i32) -> Box<dyn Fn() -> i32> {
    Box::new(move || *value)
}
fn main() {
    let local = 5;
    println!("{}", make(&local)());
}`,
  ],
  [
    'field',
    `struct Holder { callback: Box<dyn Fn() -> i32> }
fn main() {
    let local = 5;
    let holder = Holder { callback: Box::new(|| local) };
    println!("{}", (holder.callback)());
}`,
  ],
])('checks the default object lifetime of a Rust dyn %s type', (_context, program) => {
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'compileError',
    diagnostics: [expect.objectContaining({ message: expect.stringMatching(/スコープの外|static/) })],
  });
});

test('infers Rust object lifetimes inside a function body', () => {
  const program = `fn keep_static(value: &'static i32) -> Box<dyn Fn() -> i32> { Box::new(move || *value) }
fn call(callback: &dyn Fn() -> i32) -> i32 { callback() }
fn main() {
    let local = 5;
    let callback: Box<dyn Fn() -> i32> = Box::new(|| local);
    let borrowed = || local + 1;
    println!("{} {}", callback(), call(&borrowed));
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: '5 6\n',
    uncaughtException: undefined,
  });
});

test('inherits private anonymous traits through descendant glob imports', () => {
  const program = `mod source { pub use std::fmt::Write as _; }
mod ancestor {
    use super::source::*;
    pub mod child {
        use super::*;
        pub fn report() {
            let mut text = String::new();
            write!(&mut text, "glob").unwrap();
            println!("{}", text);
        }
    }
}
mod direct {
    use std::fmt::Write as _;
    pub mod child {
        use super::*;
        pub fn report() {
            let mut text = String::new();
            text.write_str("direct").unwrap();
            println!("{}", text);
        }
    }
}
fn main() {
    ancestor::child::report();
    direct::child::report();
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: 'glob\ndirect\n',
    uncaughtException: undefined,
  });
});

test('accepts Rust doc comments alongside real attributes', () => {
  const program = `/// The point to show.
#[derive(Debug)]
struct Point {
    /// Its row.
    row: i32,
}
enum Choice {
    /// The supplied point.
    Some(Point),
}
trait Paint {
    /// The default marker.
    fn marker(&self) -> i32 { 0 }
}
impl Paint for Point {
    /// Use the position as the marker.
    fn marker(&self) -> i32 { self.row }
}
impl Point {
    /// Shows the marker.
    fn show(&self) { println!("{}", self.marker()); }
}
/** Writes the chosen point. */
fn main() {
    /// Build an example.
    let point = Point { row: 7 };
    match Choice::Some(point) {
        /// Show the point.
        Choice::Some(point) => {
            /// Show the marker and the original point.
            if true { point.show(); }
            /// Display the debug form.
            println!("{:?}", point);
        },
    }
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: '7\nPoint { row: 7 }\n',
    uncaughtException: undefined,
  });
  const attribute = program.replace('/// Use the position as the marker.', '#[inline]');
  expect(executeProgram('rust', attribute)).toMatchObject({
    kind: 'compileError',
    diagnostics: [expect.objectContaining({ message: expect.stringContaining('#[inline]') })],
  });
});

test('rejects Rust doc comments on operands and initializers', () => {
  for (const statement of [
    'let mut n = 1;\n/// description\n n += 1;',
    'let _ = 1 +\n/// description\n2;',
    'let _ =\n/// description\n "text".len();',
    '/// description\n "text".len() as i64;',
  ]) {
    expect(executeProgram('rust', rustMain(statement))).toMatchObject({ kind: 'compileError' });
  }
  const valid = `fn value() -> i32 {
    /// An entire tail expression may have a doc comment.
    (1 + 2)
}
fn main() { println!("{}", value()); }`;
  expect(executeProgram('rust', valid)).toMatchObject({ kind: 'executed', stdout: '3\n' });
});

test('reborrows Rust closure referents after their original bindings end', () => {
  const program = `fn main() {
    let v = vec![1];
    let saved: Box<dyn Fn() -> i32>;
    { let x = &v[0]; saved = Box::new(|| *x); }
    println!("{}", saved());
    let typed: Box<dyn Fn() -> i32>;
    { let x = &v[0]; typed = Box::new(|| { let alias: &i32 = x; *alias }); }
    println!("{}", typed());
    let mut counter = 5;
    let mut update: Box<dyn FnMut() -> i32>;
    { let m = &mut counter; update = Box::new(|| { *m += 1; *m }); }
    println!("{}", update());
    let text = String::from("hello");
    let length: Box<dyn Fn() -> usize>;
    { let x = &text; length = Box::new(|| x.len()); }
    println!("{}", length());
    let coords = (1, 2);
    let x_value: Box<dyn Fn() -> i32>;
    { let x = &coords; x_value = Box::new(|| x.0); }
    println!("{}", x_value());
    let values = [1, 2];
    let first: Box<dyn Fn() -> i32>;
    { let x = &values; first = Box::new(|| x[0]); }
    println!("{}", first());
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: '1\n1\n6\n5\n1\n1\n',
    uncaughtException: undefined,
  });
});

test('copies only Copy projections in owned Rust closure captures', () => {
  const program = `struct Outer { inner: (String, i32) }
fn main() {
    let value = Outer { inner: (String::from("retained"), 7) };
    let reference = &value.inner.1;
    let closure = move || value.inner.1;
    println!("{} {} {} {}", closure(), value.inner.1, reference, value.inner.0);
}`;
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: '7 7 7 retained\n' });
});

test('uses character slices for Rust string boundary patterns', () => {
  const program = `fn main() {
    let chars = ['x', 'a', 'é', 'x'];
    let delimiters = &chars[1..3];
    let text = "aéhelloéa";
    println!("{} {} {} {:?} {:?}", text.trim_matches(delimiters), text.starts_with(delimiters),
      text.ends_with(delimiters), text.strip_prefix(delimiters), text.strip_suffix(delimiters));
    println!("{}", "xhellox".trim_matches(delimiters));
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: 'hello true true Some("éhelloéa") Some("aéhelloé")\nxhellox\n',
  });
});

test('validates control characters in Rust literal bodies', () => {
  for (const literal of ['"a\rb"', '"a\\\rb"', "'\r'", "'\n'", "'\t'", "b'\t'"]) {
    expect(executeProgram('rust', rustMain(`let _ = ${literal};`))).toMatchObject({ kind: 'compileError' });
  }
  const valid = rustMain(`println!("{:?} {:?} {:?}", "a\r\nb", "a\\\r\nb", '\\r');`);
  expect(executeProgram('rust', valid)).toMatchObject({ kind: 'executed', stdout: '"a\\nb" "ab" \'\\r\'\n' });
});

test('dispatches native Default calls using concrete Rust impl arguments', () => {
  const program = `struct Wrapped<T>(T);
impl Default for Wrapped<i32> { fn default() -> Self { Wrapped(42) } }
impl Default for Wrapped<bool> { fn default() -> Self { Wrapped(false) } }
struct SizedValue<T>(T, usize);
impl<T> Default for SizedValue<Option<T>> {
    fn default() -> Self { SizedValue(None, std::mem::size_of::<T>()) }
}
fn main() {
    let mut value = Wrapped(true);
    println!("{} {}", std::mem::take(&mut value).0, value.0);
    println!("{}", None::<Wrapped<bool>>.unwrap_or_default().0);
    println!("{}", None::<SizedValue<Option<u16>>>.unwrap_or_default().1);
}`;
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: 'true false\nfalse\n2\n' });
});

test('instantiates owned Rust aggregate constants independently', () => {
  const program = `enum Counter { Count(i32) }
struct Seed { counter: Counter, numbers: [i32; 2] }
const START: Seed = Seed { counter: Counter::Count(1), numbers: [2, 3] };
fn main() {
    let mut changed = START;
    let Counter::Count(n) = &mut changed.counter;
    *n = 9;
    changed.numbers[0] = 7;
    let Counter::Count(original) = START.counter;
    println!("{} {} {} {}", n, changed.numbers[0], original, START.numbers[0]);
}`;
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: '9 7 1 2\n' });
});

test('drops uncaptured Rust fields when a move closure outlives their owner', () => {
  const program = `struct Pair { keep: Turtle, drop: Turtle }
struct Outer { inner: Pair, other: Turtle }
fn main() {
    let observer = Turtle::new(1, 0);
    let mut later;
    {
        let mut value = Outer {
            inner: Pair { keep: Turtle::new(3, 3), drop: Turtle::new(1, 1) },
            other: Turtle::new(4, 4),
        };
        later = move || value.inner.keep.turn_left();
    }
    println!("{}", observer.canMoveForward());
    later();
}`;
  const execution = executeProgram('rust', program);
  expect(execution).toMatchObject({ kind: 'executed', stdout: 'true\n' });
  expect(execution.kind === 'executed' && execution.finalTurtles).toHaveLength(2);
});

test('orders Rust BTreeMap entries lexicographically', () => {
  const program = `use std::collections::{BTreeMap, BTreeSet};
fn main() {
    let a = BTreeMap::from([(1, 2)]);
    let b = BTreeMap::from([(1, 3)]);
    let unordered = BTreeMap::from([(1, f64::NAN)]);
    println!("{} {:?} {:?}", a < b, a.cmp(&b), unordered.partial_cmp(&unordered));
    println!("{}", BTreeSet::from([a, b]).len());
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: 'true Less None\n2\n',
  });
});

test('reads endpoints of bulk-built Rust ordered collections', () => {
  const program = `use std::collections::{BTreeMap, BTreeSet};
fn main() {
    let set: BTreeSet<_> = (0..12).collect();
    println!("{:?} {:?}", set.first(), set.last());
    let map: BTreeMap<_, _> = (0..12).map(|i| (i, i * 2)).collect();
    println!("{:?} {:?}", map.first_key_value(), map.last_key_value());
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: 'Some(0) Some(11)\nSome((0, 0)) Some((11, 22))\n',
  });
});

test('checks the entire Rust mutable dereference chain for writes', () => {
  for (const input of [
    'let mut x = 0; let r = &&mut x; **r = 1;',
    'let mut x = 0; let r = &&mut x; let s = &mut **r; *s = 3;',
    'let mut v = vec![0]; let r = &&mut v; r[0] = 1;',
    'let mut v = vec![0]; let r = &&mut v; (*r).push(1);',
    'use std::fmt::Write; let mut s = String::new(); write!(&s, "bad").unwrap();',
  ])
    expect(executeProgram('rust', rustMain(input))).toMatchObject({ kind: 'compileError' });

  const valid = `use std::fmt::Write;
fn write_it(target: &mut String) { writeln!(target, "hello").unwrap(); }
fn main() {
    let mut s = String::new();
    write_it(&mut s);
    print!("{}", s);
}`;
  expect(executeProgram('rust', valid)).toMatchObject({ kind: 'executed', stdout: 'hello\n' });
});

test('uses heterogeneous Rust comparisons through references, sequences and assertions', () => {
  const program = `use std::cmp::Ordering;
#[derive(Debug)]
struct A(i32);
#[derive(Debug)]
struct B(i32);
impl PartialEq<B> for A { fn eq(&self, other: &B) -> bool { self.0 == other.0 } }
impl PartialOrd<B> for A {
    fn partial_cmp(&self, other: &B) -> Option<Ordering> { self.0.partial_cmp(&other.0) }
}
fn main() {
    let a = A(1);
    let b = B(1);
    assert_eq!(&a, &b);
    assert_ne!(A(2), b);
    assert_eq!(vec![A(2)], [B(2)]);
    println!("{} {} {} {}", &&a == &&b, &a < &B(2), [A(3)] == [B(3)], &vec![A(1)][..] == &[B(1)][..]);
}`;
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: 'true true true true\n' });
});

test('rejects Rust float bitwise compound assignments after inference', () => {
  for (const op of ['&=', '|=', '^=']) {
    const source = rustMain(`let mut x = 1.0; x ${op} 2.0;`);
    expect(executeProgram('rust', source)).toMatchObject({ kind: 'compileError' });
  }
  const inferred = rustMain('let op = |mut x| { x ^= x; x }; println!("{}", op(2.0));');
  expect(executeProgram('rust', inferred)).toMatchObject({ kind: 'compileError' });
  const valid = rustMain('let mut x = 3; x &= 2; let mut b = true; b ^= true; println!("{} {}", x, b);');
  expect(executeProgram('rust', valid)).toMatchObject({ kind: 'executed', stdout: '2 false\n' });
});

test('requires Rust Clone only for borrowed sequence conversions', () => {
  for (const convert of ['Vec::from', 'Box::<[Item]>::from']) {
    const program = `struct Item(i32);
fn main() {
    let source = [Item(1)];
    let _ = ${convert}(&source[..]);
}`;
    expect(executeProgram('rust', program)).toMatchObject({ kind: 'compileError' });
  }
  const valid = `struct Item(i32);
impl Clone for Item {
    fn clone(&self) -> Self { print!("C"); Item(self.0 + 1) }
}
fn main() {
    let owned = Vec::from([Item(1)]);
    let a = Vec::from(&owned[..]);
    let b = Box::<[Item]>::from(&owned[..]);
    println!(" {} {} {}", owned[0].0, a[0].0, b[0].0);
}`;
  expect(executeProgram('rust', valid)).toMatchObject({ kind: 'executed', stdout: 'CC 1 2 2\n' });
});

test('keeps partial Rust stream output when formatting fails', () => {
  const program = `use std::fmt;
struct Bad;
impl fmt::Display for Bad {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        print!("nested ");
        write!(f, "partial")?;
        Err(fmt::Error)
    }
}
fn main() { println!("before {} after", Bad); }`;
  const out = executeProgram('rust', program);
  expect(out).toMatchObject({ kind: 'executed', stdout: 'before nested partial' });
  expect(out.kind === 'executed' && out.uncaughtException).toContain(
    'a formatting trait implementation returned an error'
  );
  const err = executeProgram('rust', program.replace('println!("before', 'eprintln!("before'));
  expect(err).toMatchObject({ kind: 'executed', stdout: 'nested ' });
  expect(err.kind === 'executed' && err.stderr).toContain('before partial');
});

test('infers numeric Rust literals through learner From implementations', () => {
  const program = `#[derive(Debug)]
struct Id(u32);
impl From<u32> for Id { fn from(n: u32) -> Self { Id(n) } }
#[derive(Debug)]
struct Scale(f32);
impl From<f32> for Scale { fn from(n: f32) -> Self { Scale(n) } }
fn show(id: Id) { println!("{:?}", id); }
fn main() {
    show(7.into());
    let scale: Scale = 1.5.into();
    println!("{:?}", scale);
}`;
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: 'Id(7)\nScale(1.5)\n' });
});

test('enforces Rust trait implementation overlap and orphan rules', () => {
  for (const overlap of ['impl P for W<i32> {}', 'impl<U> P for W<U> {}']) {
    const source = `trait P {}
struct W<T>(T);
impl<T> P for W<T> {}
${overlap}
fn main() {}`;
    expect(executeProgram('rust', source)).toMatchObject({ kind: 'compileError' });
  }
  const orphan = `struct Local;
impl<T> PartialEq<Local> for T { fn eq(&self, _: &Local) -> bool { true } }
fn main() {}`;
  expect(executeProgram('rust', orphan)).toMatchObject({ kind: 'compileError' });

  const valid = `trait P {}
trait Marker {}
struct W<T>(T);
impl<T: Marker> P for W<T> {}
impl P for W<i32> {}
struct Local(i64);
impl PartialEq<Local> for i64 { fn eq(&self, rhs: &Local) -> bool { *self == rhs.0 } }
fn main() {
    println!("{} {}", 2 == Local(2), 4_i64 == Local(3));
}`;
  expect(executeProgram('rust', valid)).toMatchObject({ kind: 'executed', stdout: 'true false\n' });
});

test('releases yielded Rust collection values while their iterator lives', () => {
  const program = `use std::collections::BTreeMap;
fn main() {
    let observer = Turtle::new(1, 0);
    let map = BTreeMap::from([(0, Turtle::new(1, 1)), (1, Turtle::new(2, 2))]);
    for (_, turtle) in map {
        drop(turtle);
        println!("{}", observer.canMoveForward());
    }
    let values = BTreeMap::from([(0, Turtle::new(1, 1))]);
    let mut iter = values.into_values();
    drop(iter.next().unwrap());
    println!("{}", observer.canMoveForward());
    for turtle in Some(Turtle::new(1, 1)) {
        drop(turtle);
        println!("{}", observer.canMoveForward());
    }
    for turtle in [Turtle::new(2, 2), Turtle::new(1, 1)].into_iter().rev() {
        drop(turtle);
        println!("{}", observer.canMoveForward());
    }
}`;
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: 'true\n'.repeat(6) });
});

test('accumulates Rust outcomes before pulling the next iterator item', () => {
  const sum = rustMain(`let values = [Some(127_i8), Some(1), None];
    let total: Option<i8> = values.into_iter().map(|item| { print!("x"); item }).sum();
    println!("{:?}", total);`);
  const product = rustMain(`let values = [Ok(255_u8), Ok(2), Err(1)];
    let total: Result<u8, i32> = values.into_iter().map(|item| { print!("x"); item }).product();
    println!("{:?}", total);`);
  for (const source of [sum, product]) {
    const execution = executeProgram('rust', source);
    expect(execution).toMatchObject({ kind: 'executed', stdout: 'xx' });
    expect(execution.kind === 'executed' && execution.uncaughtException).toContain('with overflow');
  }
  const early = rustMain(`let items = [Some(Some(1)), Some(None), None];
    let value: Option<Option<i32>> = items.into_iter().map(|item| { print!("x"); item }).sum();
    println!("{:?}", value);`);
  expect(executeProgram('rust', early)).toMatchObject({ kind: 'executed', stdout: 'xxSome(None)\n' });
});

test('clones Rust string iterator search positions and predicate state', () => {
  const program = `fn main() {
    let mut split = "one::two::three".split("::");
    assert_eq!(split.next(), Some("one"));
    let mut fork = split.clone();
    println!("{:?} {:?}", split.next(), fork.next());
    let mut lines = "one\ntwo\nthree".lines();
    assert_eq!(lines.next_back(), Some("three"));
    let mut fork = lines.clone();
    println!("{:?} {:?}", lines.next_back(), fork.next_back());
    let mut calls = 0;
    let mut iter = "abcdefg".split(move |_: char| { calls += 1; calls % 3 == 0 });
    let mut fork = iter.clone();
    println!("{:?} {:?}", iter.next(), fork.next());
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: 'Some("two") Some("two")\nSome("two") Some("two")\nSome("ab") Some("ab")\n',
  });
});

test('uses in-scope Rust trait methods before resolving ambiguity', () => {
  const program = `mod first {
    pub trait Extension { fn choose(&self) -> i32; }
    impl Extension for i32 { fn choose(&self) -> i32 { 1 } }
}
mod second {
    pub trait Extension { fn choose(&self) -> i32 { 2 } }
    impl Extension for i32 {}
}
use second::Extension;
fn bounded<T: Extension>(value: T) -> i32 { value.choose() }
fn main() { println!("{} {}", 1_i32.choose(), bounded(2_i32)); }`;
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: '2 2\n' });
});

test('enforces Rust visibility for updates, constructors and associated constants', () => {
  const declarations = `mod data {
    pub struct Record { pub shown: i32, hidden: i32 }
    pub struct Tuple(i32);
    pub struct Public(pub i32);
    impl Record {
        const HIDDEN: i32 = 7;
        pub const SHOWN: i32 = Self::HIDDEN;
    }
    pub fn record() -> Record { Record { shown: 2, hidden: 3 } }
    pub mod nested {
        pub fn access() -> i32 {
            let tuple = super::Tuple(1);
            let updated = super::Record { shown: 4, ..super::record() };
            tuple.0 + updated.shown + super::Record::HIDDEN
        }
    }
}`;
  for (const body of [
    'let _ = data::Record { shown: 4, ..data::record() };',
    'let constructor = data::Tuple; let _ = constructor(1);',
    'let _ = data::Tuple(1);',
    'let _ = data::Record::HIDDEN;',
  ]) {
    expect(executeProgram('rust', `${declarations}\n${rustMain(body)}`)).toMatchObject({ kind: 'compileError' });
  }
  const visible = rustMain('println!("{} {} {}", data::nested::access(), data::Public(5).0, data::Record::SHOWN);');
  expect(executeProgram('rust', `${declarations}\n${visible}`)).toMatchObject({ kind: 'executed', stdout: '12 5 7\n' });
});

test('validates all bindings in Rust reference and or patterns', () => {
  for (const body of [
    'let source = (String::from("x"), 1); let &(moved, _) = &source; drop(moved);',
    'let source = Some(String::from("x")); let &Some(moved) = &source else { return }; drop(moved);',
    'match (true, 4) { (true, _) | (false, extra) => (), };',
    'let (same, same) = (String::from("a"), String::from("b"));',
    'struct Pair { x: String } let Pair { x: a, x: b } = Pair { x: String::new() };',
  ]) {
    expect(executeProgram('rust', rustMain(body))).toMatchObject({ kind: 'compileError' });
  }
  const valid = rustMain(`let value = (false, 4);
    let &(flag, _) = &value;
    let n = match value { (true, n) | (false, n) => n };
    let n = n + 1;
    println!("{} {}", flag, n);`);
  expect(executeProgram('rust', valid)).toMatchObject({ kind: 'executed', stdout: 'false 5\n' });
});

test('checks generic Rust impl methods against the trait signature', () => {
  const base = `trait Pick { fn size<T>(&self, x: T) -> usize; }
struct Selector;`;
  for (const method of [
    'fn size<T, Extra>(&self, _: T) -> usize { 0 }',
    'fn size<T: std::fmt::Display>(&self, _: T) -> usize { 0 }',
  ]) {
    const source = `${base}\nimpl Pick for Selector { ${method} }\nfn main() {}`;
    expect(executeProgram('rust', source)).toMatchObject({ kind: 'compileError' });
  }
  const valid = `trait Pick { fn size<T: std::fmt::Display>(&self, x: T) -> usize; }
struct Selector;
impl Pick for Selector {
    fn size<Value: std::fmt::Display>(&self, _: Value) -> usize { std::mem::size_of::<Value>() }
}
fn main() { println!("{}", Selector.size(1_u16)); }`;
  expect(executeProgram('rust', valid)).toMatchObject({ kind: 'executed', stdout: '2\n' });
});

test('checks concrete fields of generic Rust derives under their inferred bounds', () => {
  for (const source of [
    '#[derive(Copy, Clone)] struct Packet<T> { data: Vec<T> }',
    '#[derive(PartialEq, Eq)] struct Packet<T> { data: (f32, T) }',
  ]) {
    expect(executeProgram('rust', `${source}\nfn main() {}`)).toMatchObject({ kind: 'compileError' });
  }
  const valid = `#[derive(Copy, Clone, PartialEq, Eq)]
struct Packet<T> { data: (i32, T) }
fn main() {
    let packet = Packet { data: (1, 2) };
    let copy = packet;
    println!("{}", packet == copy);
}`;
  expect(executeProgram('rust', valid)).toMatchObject({ kind: 'executed', stdout: 'true\n' });
});

test('tracks Rust moves and reinitialization by the fields an expression touches', () => {
  const valid = `struct Record { name: String, note: String }
fn main() {
    let mut pair = (String::from("a"), (String::from("b"), String::from("c")));
    let old = pair.1.0;
    pair.1 = (String::from("d"), String::from("e"));
    let dropped = pair.1.1;
    let (keep, _) = pair.1;
    let record = Record { name: old, note: dropped };
    let name = record.name;
    let revised = Record { name: keep, ..record };
    let value = Some(String::from("f"));
    println!("{} {} {} {} {:?}", name, revised.name, revised.note, matches!(value, Some(_)), value);
}`;
  expect(executeProgram('rust', valid)).toMatchObject({
    kind: 'executed',
    stdout: 'b d e true Some("f")\n',
  });
  for (const body of [
    'let value = Some(String::from("a")); matches!(value, Some(x)); println!("{:?}", value);',
    'let mut value = ((String::from("a"),),); let moved = value.0; value.0.0 = String::from("b");',
    'let value = (String::from("a"), 1); let moved = value.0; let (bad, _) = value;',
  ]) {
    expect(executeProgram('rust', rustMain(body))).toMatchObject({ kind: 'compileError' });
  }
});

test('applies Rust blanket and parsing traits to generic helper types', () => {
  const program = `use std::collections::HashMap;
use std::hash::Hash;
use std::str::FromStr;
fn lookup<K: Hash + Eq, V: Copy>(map: &HashMap<K, V>, key: &K) -> Option<V> {
    map.get(key).copied()
}
fn roundtrip<T>(value: T) -> T { T::from(value).into() }
fn parsed<T: FromStr>(source: &str) -> Option<T> { source.parse().ok() }
fn extend<T>(target: &mut Vec<T>, items: Vec<T>) { target.extend(items); }
fn main() {
    let map = HashMap::from([(1, 2)]);
    let mut out = vec![roundtrip(String::from("old"))];
    extend(&mut out, vec![String::from("new")]);
    println!("{:?} {:?} {:?}", lookup(&map, &1), parsed::<f64>("1.5"), out);
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: 'Some(2) Some(1.5) ["old", "new"]\n',
  });
});

test('defaults Rust literals in trait arguments before the final solve', () => {
  const program = rustMain(`let int = i64::from(3);
    let float = f64::from(2);
    let values: Vec<_> = vec![1, 2].into_iter().map(i64::from).collect();
    println!("{} {} {:?} {:?}", int, float, Some(3).map(i64::from), values);`);
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: '3 2 Some(3) [1, 2]\n',
  });
});

test('consumes generic and boxed Rust FnOnce callees', () => {
  const generic = `fn twice<F: FnOnce()>(callback: F) { callback(); callback(); }
fn main() {}`;
  const boxed = rustMain(`let callback: Box<dyn FnOnce()> = Box::new(|| {});
    callback();
    callback();`);
  expect(executeProgram('rust', generic)).toMatchObject({ kind: 'compileError' });
  expect(executeProgram('rust', boxed)).toMatchObject({ kind: 'compileError' });
  const valid = `fn twice<F: FnOnce() + Copy>(callback: F) { callback(); callback(); }
fn main() {
    twice(|| print!("x"));
    let callback: Box<dyn FnOnce()> = Box::new(|| print!("y"));
    callback();
}`;
  expect(executeProgram('rust', valid)).toMatchObject({ kind: 'executed', stdout: 'xxy' });
});

test('uses qualified Rust constants in array types and repeat counts', () => {
  const program = `mod board {
    pub const SIZE: usize = 2;
    pub struct Grid(pub [[u8; Grid::SIZE]; SIZE]);
    impl Grid {
        pub const SIZE: usize = SIZE + 1;
        pub fn new() -> Self { Grid([[7; Self::SIZE]; SIZE]) }
    }
}
fn main() {
    let row = [4; board::Grid::SIZE];
    let width = [0; board::SIZE];
    let grid = board::Grid::new();
    println!("{:?} {} {:?}", row, width.len(), grid.0);
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: '[4, 4, 4] 2 [[7, 7, 7], [7, 7, 7]]\n',
  });
});

test('requires Sized for inferred Rust generic arguments', () => {
  const declarations = `fn show<T: std::fmt::Display>(value: &T) { println!("{}", value); }
struct Named<'a, T> { value: &'a T }
struct Tuple<'a, T>(&'a T);`;
  for (const body of ['show("a");', 'let _ = Named { value: "a" };', 'let _ = Tuple("a");']) {
    expect(executeProgram('rust', `${declarations}\n${rustMain(body)}`)).toMatchObject({ kind: 'compileError' });
  }
  const valid = rustMain('show(&"a"); let named = Named { value: &"b" }; println!("{}", named.value);');
  expect(executeProgram('rust', `${declarations}\n${valid}`)).toMatchObject({ kind: 'executed', stdout: 'a\nb\n' });
});

test('validates Rust trait objects in declarations and through supertraits', () => {
  for (const declarations of [
    'trait Object { fn generic<T>(&self, value: T); } struct Holder { object: Box<dyn Object> }',
    'trait Base { fn clone_like(&self) -> Self; } trait Middle: Base {} trait Leaf: Middle {} fn take(_: &dyn Leaf) {}',
    'trait Object { fn compare(&self, other: &Self); } fn take(_: Box<dyn Object>) {}',
    'trait Object: Sized { fn get(&self) -> i32; } struct Holder { object: Box<dyn Object> }',
  ]) {
    expect(executeProgram('rust', `${declarations}\nfn main() {}`)).toMatchObject({ kind: 'compileError' });
  }
  const valid = `trait Object {
    fn excluded<T>(&self, value: T) where Self: Sized;
    fn count(&self) -> i32;
}
struct Holder { object: Box<dyn Object> }
struct Counter;
impl Object for Counter {
    fn excluded<T>(&self, _: T) {}
    fn count(&self) -> i32 { 7 }
}
fn main() {
    let value = Holder { object: Box::new(Counter) };
    println!("{}", value.object.count());
}`;
  expect(executeProgram('rust', valid)).toMatchObject({ kind: 'executed', stdout: '7\n' });
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
  ['available-in-Rust deque append', 'let mut a = std::collections::VecDeque::from([1]); a.append(&mut a.clone());'],
  ['available-in-Rust integer Add method (stage C)', 'let n = 1i32; let _ = n.add(2);', 'use std::ops::Add;'],
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

test.each(['println!', 'vec!'])('bounds the depth of reparsed Rust %s arguments', (macro) => {
  const expression = Array.from({ length: 9500 }, () => '1').join('+');
  const args = macro === 'println!' ? `"{}", ${expression}` : expression;
  const program = rustMain(`${macro}(${args});`);
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 1, message: expect.stringContaining('入れ子が深すぎます') }],
  });
});

test('loan analysis leaves the execution budget available to straight-line programs', () => {
  const statements = Array.from(
    { length: 140 },
    (_, index) => `v.push(${index}); let n${index} = v.len(); total += n${index};`
  );
  const program = rustMain(`let mut v = Vec::new(); let mut total = 0;
${statements.join('\n')}
println!("{}", total);`);
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: '9870\n' });
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
  [
    'implicit copies of aggregates',
    'let a = [0u8; 1000]; let mut copies = Vec::new(); for _ in 0..1001 { copies.push(a); }',
  ],
  ['default values for nested arrays', 'let a: [[[[i32; 32]; 32]; 32]; 32] = Default::default();'],
  [
    'elements added to a heap',
    'let _allocated = vec![0; 999_990]; let mut h = std::collections::BinaryHeap::new(); h.extend(0..20);',
  ],
  [
    'entries added to a map',
    'let _allocated = vec![0; 999_990]; let mut m = std::collections::HashMap::new(); m.extend((0..6).zip(0..6));',
  ],
  [
    'materialized borrowed collection iterators',
    'let _allocated = vec![0; 999_960]; let s: std::collections::HashSet<_> = (0..15).collect(); let a = s.iter(); let b = s.iter(); println!("{} {}", a.len(), b.len());',
  ],
  [
    'owned hash set operator results',
    'let _allocated = vec![0; 999_945]; let a: std::collections::HashSet<_> = (0..15).collect(); let b: std::collections::HashSet<_> = (15..30).collect(); let _union = &a | &b;',
  ],
  ['a trailing format literal', `let s = format!("{}{}", "a".repeat(999_000), "${'b'.repeat(1024)}");`],
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

test('requires structural equality for constants used in Rust patterns', () => {
  const program = `mod cases {
    pub struct Manual(pub i32);
    impl PartialEq for Manual { fn eq(&self, other: &Self) -> bool { self.0 == other.0 } }
    pub const WRAPPED: (Manual,) = (Manual(1),);
    pub const EMPTY: Option<Manual> = None;
}
fn main() {
    match (cases::Manual(1),) { cases::WRAPPED => (), _ => () }
}`;
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'compileError' });
  expect(
    executeProgram(
      'rust',
      program.replace(
        'match (cases::Manual(1),) { cases::WRAPPED => (), _ => () }',
        'match None::<cases::Manual> { cases::EMPTY => println!("empty"), _ => () }'
      )
    )
  ).toMatchObject({ kind: 'executed', stdout: 'empty\n' });
});

test('requires Rust unit enum variant names in patterns to resolve', () => {
  const program = `enum Direction { Up, Down }
fn main() {
    let d = Direction::Down;
    println!("{}", match &d { Up => 1, Direction::Down => 2, _ => 3 });
}`;
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'compileError' });
  expect(executeProgram('rust', program.replace('Up =>', 'Direction::Up =>'))).toMatchObject({
    kind: 'executed',
    stdout: '2\n',
  });
});

test('drops Rust turtles moved into coerced owners', () => {
  const program = `trait Contents {}
struct Owner { turtle: Turtle }
impl Contents for Owner {}
fn main() {
    let input = Box::new(Owner { turtle: Turtle::new(1, 1) });
    {
        let erased: Box<dyn Contents> = input;
    }
    let turtles = vec![Turtle::new(2, 2)];
    {
        let zipped = (0..1).zip(turtles);
    }
}`;
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', finalTurtles: [] });
});

test('retains Rust turtles still owned by iterator adapters', () => {
  const program = `fn main() {
    let first = vec![Turtle::new(1, 1)];
    let second = vec![Turtle::new(2, 2)];
    let chained = first.into_iter().chain(second);
    let mut flattened = vec![vec![Turtle::new(3, 3), Turtle::new(4, 4)]].into_iter().flatten();
    { let drawn = flattened.next(); }
}`;
  const result = executeProgram('rust', program);
  expect(result.kind === 'executed' && result.finalTurtles.map(({ x }) => x).toSorted((a, b) => a - b)).toEqual([
    1, 2, 4,
  ]);
});

test('uses empty slices after a Rust inclusive range is exhausted', () => {
  const program = rustMain(`let mut range = 0usize..=1;
    range.next();
    range.next();
    println!("{:?} {:?}", &vec![10, 20, 30][range.clone()], "abc".get(range));
    let mut within_char = 0usize..=0;
    within_char.next();
    println!("{:?}", "é".get(within_char));`);
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: '[] Some("")\nNone\n' });
});

test('uses Rust heterogeneous equality through nested containers and generic bounds', () => {
  const program = `fn equal<T: PartialEq<U>, U>(a: &T, b: &U) -> bool { a == b }
fn main() {
    let values = vec![vec![1, 2], vec![3, 4]];
    assert_eq!(values, [[1, 2], [3, 4]]);
    println!("{}", equal(&values, &vec![[1, 2], [3, 4]]));
    println!("{}", vec![vec![String::from("a")]] == [["a"]]);
}`;
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: 'true\ntrue\n' });
});

test('forwards Rust callable trait bounds through captures, references, and boxes', () => {
  const program = `fn once<F: FnOnce()>(callback: F) {
    let wrapper = || callback();
    wrapper();
}
fn shared<F: Fn()>(callback: F) { callback(); }
fn by_ref<F: Fn()>(callback: &F) { shared(callback); }
fn main() {
    once(|| println!("once"));
    by_ref(&|| println!("shared"));
    let boxed: Box<dyn Fn()> = Box::new(|| println!("boxed"));
    shared(boxed);
}`;
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: 'once\nshared\nboxed\n' });
  const mutable = program.replace('F: FnOnce()>(callback: F)', 'F: FnMut()>(mut callback: F)');
  expect(executeProgram('rust', mutable)).toMatchObject({ kind: 'compileError' });
});

test('drops Rust turtles moved out of Box storage', () => {
  const program = rustMain(
    `let wrapped = Box::new(Owner { turtle: Turtle::new(1, 1) });
    let boxed = Box::new(Turtle::new(2, 2));
    { let first = wrapped.turtle; let second = *boxed; }`,
    'struct Owner { turtle: Turtle }'
  );
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', finalTurtles: [] });
});

test('validates Rust constant initializers before normal execution', () => {
  const valid = `const LENGTH: usize = "hi".len();
const EMPTY: Vec<u8> = vec![];
const VALUE: Option<u16> = Some(2);
fn main() {
    println!("{} {} {} {}", LENGTH, EMPTY.len(), VALUE.is_some(), std::mem::size_of::<u32>());
}`;
  expect(executeProgram('rust', valid)).toMatchObject({ kind: 'executed', stdout: '2 0 true 4\n' });
  for (const value of ['side_effect()', '{ println!("called"); 2 }']) {
    const invalid = `fn side_effect() -> i32 { println!("called"); 2 }
struct Record;
impl Record { const INITIAL: i32 = ${value}; }
fn main() {}`;
    expect(executeProgram('rust', invalid)).toMatchObject({ kind: 'compileError' });
  }
});

test('enforces Rust restricted visibility for paths and imports', () => {
  const program = `mod parent {
    pub mod child {
        pub(super) fn message() { println!("visible"); }
        pub(self) fn hidden() {}
    }
    pub(self) use child::message as alias;
    pub fn allowed() { alias(); }
}
fn main() { parent::allowed(); }`;
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: 'visible\n' });
  for (const call of ['parent::child::message()', 'parent::child::hidden()', 'parent::alias()']) {
    expect(executeProgram('rust', program.replace('parent::allowed()', call))).toMatchObject({ kind: 'compileError' });
  }
});

test('rejects ambiguous Rust glob imports and accepts two routes to one item', () => {
  const program = `mod a { pub fn show() { println!("a"); } }
mod b { pub fn show() { println!("b"); } }
use a::*;
use b::*;
fn main() { show(); }`;
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'compileError' });
  const reexport = program.replace('pub fn show() { println!("b"); }', 'pub use super::a::show;');
  expect(executeProgram('rust', reexport)).toMatchObject({ kind: 'executed', stdout: 'a\n' });
});

test('resolves Rust trait calls through argument types and impl bounds', () => {
  const program = `struct Name(String);
impl From<Name> for String { fn from(n: Name) -> String { n.0 } }
impl PartialEq<Name> for i32 {
    fn eq(&self, n: &Name) -> bool { *self == n.0.len() as i32 }
}
trait Mark {}
trait Mode { fn value(&self) -> i32; }
struct Tagged;
impl Mark for Tagged {}
struct Wrapped<T>(T);
impl<T: Mark> Mode for Wrapped<T> { fn value(&self) -> i32 { 1 } }
impl Mode for Wrapped<i32> { fn value(&self) -> i32 { 2 } }
fn inspect<T: Mode>(value: T) -> i32 { value.value() }
fn main() {
    let n = Name(String::from("Ann"));
    println!("{} {} {}", 3i32.eq(&n), 3i32.eq(&3), String::from(n));
    println!("{} {}", inspect(Wrapped(42)), inspect(Wrapped(Tagged)));
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: 'true true Ann\n2 1\n',
  });
});

test('rejects Rust trait overlap with implicit impls and ambiguity among bounds', () => {
  const conflicts = [
    '#[derive(Clone)] struct S; impl Clone for S { fn clone(&self) -> S { S } } fn main() {}',
    'struct S; impl<T> From<T> for S { fn from(_: T) -> S { S } } fn main() {}',
    `trait A { fn show(&self); }
trait B { fn show(&self); }
fn show<T: A + B>(value: &T) { value.show(); }
fn main() {}`,
    `trait A { fn show(&self); }
trait B { fn show(&self); }
fn show<T: A + B>(value: &T) { T::show(value); }
fn main() {}`,
  ];
  for (const program of conflicts) expect(executeProgram('rust', program)).toMatchObject({ kind: 'compileError' });
});

test('keeps Rust trait object captures borrowed until their owner drops', () => {
  const program = rustMain(`let mut source = 5;
    let original = &mut source;
    let saved: (Box<dyn Fn() -> i32>,) = (Box::new(|| *original),);
    println!("{}", (saved.0)());
    let next: &mut i32 = original;
    println!("{}", next);`);
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'compileError' });
  const released = program.replace('let next:', 'drop(saved.0); let next:');
  expect(executeProgram('rust', released)).toMatchObject({ kind: 'executed', stdout: '5\n5\n' });
});

test('reborrows Rust references passed to associated method receivers', () => {
  const program = rustMain(`let mut values = vec![1];
    let receiver = &mut values;
    Vec::push(receiver, 2);
    Vec::push(receiver, 3);
    println!("{:?}", values);`);
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: '[1, 2, 3]\n' });
});

test('keeps Rust trait comparison operands borrowed until the comparison', () => {
  const program = rustMain(`let mut items = vec![1];
    let equal = items == { items.push(2); vec![1, 2] };
    println!("{}", equal);`);
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'compileError' });
  const primitive = rustMain(`let mut value = 1;
    let equal = value == { value = 2; 1 };
    println!("{} {}", equal, value);`);
  expect(executeProgram('rust', primitive)).toMatchObject({ kind: 'executed', stdout: 'true 2\n' });
});

test('resolves raw Rust identifiers by their names', () => {
  const program = `mod r#scope {
    pub struct r#Record { pub r#data: i32 }
    impl Record { pub fn r#get(&self) -> i32 { self.data } }
}
use scope::r#Record as r#Name;
fn main() {
    let record = Name { r#data: 3 };
    let Name { data: r#type } = record;
    println!("{type} {}", record.get());
}`;
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: '3 3\n' });
});

test('reports a Rust three-dot range as a compile error', () => {
  expect(executeProgram('rust', rustMain('for value in 0...3 { println!("{}", value); }'))).toMatchObject({
    kind: 'compileError',
  });
});

test('formats a Rust radix sign ahead of prefixes and zero padding', () => {
  const program = rustMain(`println!("{:+x} {:+#x} {:+#08x} {:+x} {:+x?}", 254, 254, 254, -15i8, 254);
    println!("{:+e} {:+?} {:+x?} {:+}", f64::NAN, 254, -15i8, -0.0);`);
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: '+fe +0xfe +0x000fe +f1 +fe\nNaN +254 +f1 -0\n',
  });
});

test('uses computed Rust constants to check exhaustive structural patterns', () => {
  const branches = [
    'if let Some(true) = Some(true) { (true, false) } else { (false, false) }',
    "if true == true && 'a' < 'b' { (true, false) } else { (false, false) }",
    'match Some(true) { Some(value) => (value, false), None => (false, false) }',
  ];
  for (const branch of branches) {
    const program = `const CASE: (bool, bool) = ${branch};
fn main() {
    match (true, false) { CASE => println!("hit"), (false, _) => (), (true, true) => () }
}`;
    expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: 'hit\n' });
  }
});

test('accepts Rust const numeric methods and rejects destruction of values in const scopes', () => {
  const program = `const VALUE: i32 = 2_i32.pow(3) + i32::abs(-3);
const EMPTY: Vec<u16> = { let result = Vec::new(); result };
const NO_DROP: () = { let _value: Option<String> = None; };
fn main() { println!("{} {}", VALUE, EMPTY.len()); }`;
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: '11 0\n' });
  for (const invalid of [
    'const INVALID: usize = Vec::<u16>::new().as_slice().len();',
    'const INVALID: () = { let _value = Vec::<i32>::new(); };',
    'const INVALID: () = { let _ = String::new(); };',
  ]) {
    expect(executeProgram('rust', invalid + '\n' + program)).toMatchObject({ kind: 'compileError' });
  }
});

test('validates Rust match ergonomics, wildcard reads, and floating constants', () => {
  const program = `#[derive(Debug)] enum Direction { Up, Down }
fn main() {
    let item = Some(Direction::Down);
    match &item { Some(Down) => println!("{:?}", Down), None => () }
    let moved = String::from("a");
    drop(moved);
    let _ = moved;
    match moved { _ => println!("discarded") }
}`;
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: 'Down\ndiscarded\n' });
  const nan = `const NAN: (f64, bool) = (0.0 / 0.0, true);
fn main() { match (0.0, true) { NAN => (), _ => () } }`;
  expect(executeProgram('rust', nan)).toMatchObject({ kind: 'compileError' });
});

test('requires Rust collection bounds for keyed methods while leaving construction unbounded', () => {
  const program = `use std::collections::{BTreeMap, HashSet};
use std::hash::Hash;
fn count<T: Ord>(map: &BTreeMap<T, i32>) -> usize { map.range(..).count() }
fn union<T: Eq + Hash>(set: &HashSet<T>) -> usize { set.union(set).count() }
fn main() {
    let empty = BTreeMap::<f64, i32>::new();
    println!("{} {} {}", empty.len(), count(&BTreeMap::from([(1, 2)])), union(&HashSet::from([1, 2])));
}`;
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: '0 1 2\n' });
  for (const bound of ['T: Ord', 'T: Eq + Hash']) {
    expect(executeProgram('rust', program.replace(bound, 'T'))).toMatchObject({ kind: 'compileError' });
  }
});

test('drops Rust collection elements rejected by retain before the next predicate', () => {
  for (const [constructor, method] of [
    ['vec![Turtle::new(1, 6), Turtle::new(1, 5)]', 'retain'],
    ['vec![Turtle::new(1, 6), Turtle::new(1, 5)]', 'retain_mut'],
    ['std::collections::VecDeque::from([Turtle::new(1, 6), Turtle::new(1, 5)])', 'retain'],
  ]) {
    const program = rustMain(`let mut turtles = ${constructor};
    turtles.${method}(|turtle| turtle.canMoveForward());
    println!("{}", turtles.len());`);
    const execution = executeProgram('rust', program);
    expect(execution).toMatchObject({ kind: 'executed', stdout: '1\n', finalTurtles: [{ x: 1, y: 5 }] });
  }
});

test('checks Rust enum constructor bounds for inline and where declarations', () => {
  for (const declaration of ['enum Case<T: Clone> { Some(T) }', 'enum Case<T> where T: Clone { Some(T) }']) {
    const program = declaration + '\nstruct Value(i32);\nfn main() { let _ = Case::Some(Value(1)); }';
    expect(executeProgram('rust', program)).toMatchObject({ kind: 'compileError' });
    expect(executeProgram('rust', program.replace('struct Value', '#[derive(Clone)] struct Value'))).toMatchObject({
      kind: 'executed',
    });
  }
});

test('releases Rust borrows when an owning callback is replaced', () => {
  const program = rustMain(`let mut source = 5;
    let original = &mut source;
    let mut callback: Box<dyn Fn() -> i32> = Box::new(|| *original);
    println!("{}", callback());
    callback = Box::new(|| 2);
    let next: &mut i32 = original;
    println!("{}", next);`);
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: '5\n5\n' });
  const conditional = program.replace('callback = Box::new(|| 2);', 'if false { callback = Box::new(|| 2); }');
  expect(executeProgram('rust', conditional)).toMatchObject({ kind: 'compileError' });
});

test('keeps Rust callback borrows through nested owners and collection insertion', () => {
  for (const [owner, call] of [
    ['let values: Vec<Box<dyn Fn() -> i32>> = vec![Box::new(|| *original)];', 'values[0]()'],
    ['let mut values: Vec<Box<dyn Fn() -> i32>> = vec![]; values.push(Box::new(|| *original));', 'values[0]()'],
    ['let values: Box<Box<dyn Fn() -> i32>> = Box::new(Box::new(|| *original));', '(**values)()'],
  ]) {
    const drawing = `${owner} println!("{}", ${call});`;
    const program = rustMain(`let mut source = 5;
    let original = &mut source;
    ${drawing}
    let next: &mut i32 = original;
    println!("{}", next);`);
    expect(executeProgram('rust', program)).toMatchObject({ kind: 'compileError' });
    expect(executeProgram('rust', program.replace(drawing, `{ ${drawing} }`))).toMatchObject({
      kind: 'executed',
      stdout: '5\n5\n',
    });
  }
});

test('tracks active Rust const variants through declarations and assignment', () => {
  const program = `const FIRST: () = { let mut value: Option<String> = None; value = None; };
const SECOND: () = { let (value, n) = (None::<String>, 1); };
fn main() { println!("ok"); }`;
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: 'ok\n' });
  const assignedOwned = program.replace('value = None; };', 'value = Some(String::new()); };');
  expect(executeProgram('rust', assignedOwned)).toMatchObject({ kind: 'compileError' });
});

test('matches constants by path while evaluating Rust structural constants', () => {
  const program = `const ON: bool = true;
const CASE: (bool, bool) = match true { ON => (true, false), _ => (false, false) };
fn main() { match (true, false) { CASE => println!("hit"), (false, _) => (), (true, true) => () } }`;
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: 'hit\n' });
});

test('parses Rust loop results that start with operators and closures', () => {
  const program = rustMain(`let n = 7;
    let reference = loop { break &n; };
    let signed = loop { break -(2 - 1); };
    let callback = loop { break || 6; };
    let branch = if loop { break true; } { 3 } else { 4 };
    println!("{} {} {} {}", reference, signed, callback(), branch);`);
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: '7 -1 6 3\n' });
});

test('preserves reference reborrows when classifying Rust closures', () => {
  const program = rustMain(`let mut values = vec![1];
    let reference = &mut values;
    let mut append = || Vec::push(reference, 2);
    append();
    append();
    let mut text = String::new();
    let reference = &mut text;
    let mut extend = || String::push_str(reference, "x");
    extend();
    extend();
    println!("{:?} {}", values, text);`);
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: '[1, 2, 2] xx\n' });

  const consumesReference = rustMain(
    'let mut value = 1; let reference = &mut value; let consume = || take(reference); consume(); consume();',
    'fn take<T>(_: T) {}'
  );
  expect(executeProgram('rust', consumesReference).kind).toBe('compileError');
});

test('preserves visibility for tuple fields and resolves aliases of prelude names', () => {
  const modules = `mod parent {
      pub mod child {
        pub struct Restricted(pub(super) i32);
        pub struct Private(pub(self) i32);
        pub fn make() -> Restricted { Restricted(3) }
      }
      pub fn read() -> i32 { child::make().0 + child::Restricted(4).0 }
    }`;
  const valid = rustMain('let v: V<i32> = vec![parent::read()]; println!("{:?}", v);', `use Vec as V; ${modules}`);
  expect(executeProgram('rust', valid)).toMatchObject({ kind: 'executed', stdout: '[7]\n' });
  expect(executeProgram('rust', rustMain('let _ = parent::child::make().0;', modules)).kind).toBe('compileError');
  expect(executeProgram('rust', rustMain('let _ = parent::child::Private(1);', modules)).kind).toBe('compileError');
});

test('enforces Rust collection bounds in method signatures and generic conversions', () => {
  const imports = 'use std::collections::{HashSet, HashMap, BinaryHeap};';
  for (const body of [
    'let _: HashSet<f64> = [1.0].into_iter().collect();',
    'let _ = HashMap::from([(1.0_f64, 2)]);',
    'let _ = BinaryHeap::from(vec![1.0_f64]);',
  ]) {
    expect(executeProgram('rust', rustMain(body, imports)).kind).toBe('compileError');
  }
  const valid = rustMain('let m = HashMap::from([(1, 2)]); println!("{:?}", m.get(&1));', imports);
  expect(executeProgram('rust', valid)).toMatchObject({ kind: 'executed', stdout: 'Some(2)\n' });
});

test('finds and folds Rust iterator elements in reverse order', () => {
  const program = rustMain(`let mut values = [1, 2, 3, 4].into_iter().filter(|n| *n < 4);
    println!("{:?} {:?}", values.rfind(|n| *n % 2 == 0), values.rfind(|n| *n % 2 == 0));
    println!("{}", [1, 2, 3].into_iter().rfold(0, |acc, n| acc * 10 + n));`);
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: 'Some(2) None\n321\n' });
  expect(executeProgram('rust', rustMain('let _ = (0..).rfold(0, |acc, n| acc + n);')).kind).toBe('compileError');
});

test('returns borrowed Rust slice partitions and preserves mutations through them', () => {
  const program = rustMain(`let mut values = [1, 2, 3];
    let (a, b) = values.split_at(1);
    println!("{:?} {:?}", a, b);
    println!("{:?} {:?}", values.split_first(), values.split_last());
    let (a, b) = values.split_at_mut(1);
    a[0] = 4;
    b[0] = 5;
    println!("{:?}", values);`);
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: '[1] [2, 3]\nSome((1, [2, 3])) Some((3, [1, 2]))\n[4, 5, 3]\n',
  });
});

test('rejects initializer panics in unused Rust constants before main runs', () => {
  for (const declaration of [
    'const BAD: i8 = 127_i8.pow(2);',
    'struct S; impl S { const BAD: i32 = i32::abs(i32::MIN); }',
    'const BAD: i32 = 1_i32.checked_div(0).unwrap();',
  ]) {
    expect(executeProgram('rust', rustMain('println!("main");', declaration)).kind).toBe('compileError');
  }
  const valid = rustMain('println!("{}", EMPTY.len());', 'const EMPTY: Vec<i32> = Vec::new();');
  expect(executeProgram('rust', valid)).toMatchObject({ kind: 'executed', stdout: '0\n' });
});

test('enforces Rust ADT trait bounds wherever a generic type is written', () => {
  const declaration = 'struct S<T> where T: Copy { value: T }';
  for (const usage of ['fn read(_: S<String>) {}', 'struct Holder { value: Option<S<String>> }']) {
    expect(executeProgram('rust', rustMain('', `${declaration} ${usage}`)).kind).toBe('compileError');
  }
  const valid = rustMain(
    'println!("{}", read(S { value: 4 }));',
    `${declaration} fn read<T: Copy>(s: S<T>) -> T { s.value }`
  );
  expect(executeProgram('rust', valid)).toMatchObject({ kind: 'executed', stdout: '4\n' });
});

test('selects the Rust trait bound that agrees with the call signature', () => {
  const declarations = `trait A<T> { fn get(&self) -> T; fn make(value: T) -> T; }
    trait Both: A<bool> + A<i32> {}
    struct S;
    impl A<bool> for S { fn get(&self) -> bool { true } fn make(value: bool) -> bool { value } }
    impl A<i32> for S { fn get(&self) -> i32 { 3 } fn make(value: i32) -> i32 { value } }
    impl Both for S {}`;
  const valid = rustMain(
    'println!("{:?}", run(&S));',
    `${declarations}
      fn run<X: Both>(x: &X) -> (i32, bool) {
        let number: i32 = x.get();
        let flag: bool = X::make(false);
        (number, flag)
      }`
  );
  expect(executeProgram('rust', valid)).toMatchObject({ kind: 'executed', stdout: '(3, false)\n' });
  for (const bounds of ['A<i32> + A<bool>', 'A<bool> + A<i32>', 'Both']) {
    const ambiguous = rustMain('', `${declarations} fn run<X: ${bounds}>(x: &X) { let _ = x.get(); }`);
    expect(executeProgram('rust', ambiguous).kind).toBe('compileError');
  }
});

test('validates Rust String mutation ranges before checking UTF-8 boundaries', () => {
  const invalidRanges = [
    ['drain(9..)', 'core/src/slice/index.rs:1020:55', 'range start index 9 out of range for slice of length 6'],
    ['drain(2..9)', 'core/src/slice/index.rs:1009:51', 'range end index 9 out of range for slice of length 6'],
    ['drain(3..2)', 'core/src/slice/index.rs:1020:55', 'slice index starts at 3 but ends at 2'],
    [
      'replace_range(..=usize::MAX, "a")',
      'core/src/slice/index.rs:1005:52',
      'range end index 18446744073709551615 out of range for slice of length 6',
    ],
    ['drain(..2)', 'src/main.rs:', 'assertion failed: self.is_char_boundary(end)'],
    ['replace_range(2.., "a")', 'src/main.rs:', 'start of range should be a character boundary'],
    ['replace_range(..2, "a")', 'src/main.rs:', 'end of range should be a character boundary'],
  ];
  for (const [call, location, message] of invalidRanges) {
    const result = executeProgram('rust', rustMain(`let mut s = String::from("héllo"); s.${call};`));
    expect(result).toMatchObject({ kind: 'executed', uncaughtException: expect.stringContaining(location) });
    expect(result).toMatchObject({ uncaughtException: expect.stringContaining(message) });
  }
  const program = rustMain(`let mut s = String::from("aé🐢z");
    let removed: String = s.drain(1..3).collect();
    s.replace_range(1..=4, "b");
    println!("{} {}", removed, s);`);
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: 'é abz\n' });
});

test('uses the Rust panic text for the slice clone implementation and deque index', () => {
  for (const [body, items, message] of [
    [
      '[0, 0].clone_from_slice(&[1]);',
      '',
      'copy_from_slice: source slice length (1) does not match destination slice length (2)',
    ],
    [
      '[String::new(), String::new()].clone_from_slice(&[String::new()]);',
      '',
      'destination and source slices have different lengths',
    ],
    [
      '[Manual, Manual].clone_from_slice(&[Manual]);',
      'struct Manual; impl Copy for Manual {} impl Clone for Manual { fn clone(&self) -> Self { *self } }',
      'destination and source slices have different lengths',
    ],
  ]) {
    expect(executeProgram('rust', rustMain(body, items))).toMatchObject({
      kind: 'executed',
      uncaughtException: expect.stringContaining(message),
    });
  }
  for (const [args, line, index] of [
    ['2, 3', 1030, 'i'],
    ['0, 2', 1031, 'j'],
  ] as const) {
    const program = rustMain(`std::collections::VecDeque::from([1, 2]).swap(${args});`);
    expect(executeProgram('rust', program)).toMatchObject({
      kind: 'executed',
      uncaughtException: expect.stringContaining(
        `alloc/src/collections/vec_deque/mod.rs:${line}:9:\nassertion failed: ${index} < self.len()`
      ),
    });
  }
});

test('formats fieldless Rust derives independently of Debug width', () => {
  const program = rustMain(
    `println!("[{:>6?}] [{:<7?}] [{:>8?}] [{:>8?}] [{:>4?}] [{:>8?}]",
       Unit, Direction::North, std::cmp::Ordering::Less, None::<i32>, (), vec![Direction::East]);`,
    '#[derive(Debug)] struct Unit; #[derive(Debug)] enum Direction { North, East }'
  );
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: '[Unit] [North] [Less] [None] [  ()] [[East]]\n',
  });
});

test('uses evaluated Rust constants for pattern validation and coverage', () => {
  for (const [constant, value] of [
    ['const N: f32 = f32::NAN.abs();', '0.0_f32'],
    ['const N: Option<[f64; 2]> = Some([0.0, f64::NAN.copysign(-1.0)]);', 'Some([0.0; 2])'],
  ]) {
    const program = rustMain(`match ${value} { N => (), _ => () }`, constant);
    expect(executeProgram('rust', program)).toMatchObject({
      kind: 'compileError',
      diagnostics: [expect.objectContaining({ message: expect.stringContaining('NaN') })],
    });
  }
  const valid = rustMain(
    'match Some(true) { YES => println!("yes"), Some(false) | None => () }',
    'const YES: Option<bool> = Some((-1_i32).abs() == 1);'
  );
  expect(executeProgram('rust', valid)).toMatchObject({ kind: 'executed', stdout: 'yes\n' });
});

test('validates Rust associated constants at their concrete instantiations', () => {
  const declarations = `struct S<T>(T);
    impl<T> S<T> { const BAD: i8 = i8::abs(i8::MIN); const SIZE: usize = std::mem::size_of::<T>(); }
    fn bad<T>() -> i8 { S::<T>::BAD }`;
  for (const value of ['S::<i32>::BAD', 'bad::<i32>()']) {
    expect(executeProgram('rust', rustMain(`println!("before"); println!("{}", ${value});`, declarations)).kind).toBe(
      'compileError'
    );
  }
  const valid = rustMain('println!("{} {}", S::<i16>::SIZE, S::<u64>::SIZE);', declarations);
  expect(executeProgram('rust', valid)).toMatchObject({ kind: 'executed', stdout: '2 8\n' });
});

test('checks destruction of the active variant in each Rust const array element', () => {
  const valid = rustMain('println!("ok");', 'const X: () = { let unused = ([None::<String>, None],); };');
  expect(executeProgram('rust', valid)).toMatchObject({ kind: 'executed', stdout: 'ok\n' });
  const discardedString = rustMain('', 'const X: () = { let unused = [None, Some(String::new())]; };');
  expect(executeProgram('rust', discardedString).kind).toBe('compileError');
});

test('uses the comparison trait bounds of the Rust BTree keys', () => {
  const program = rustMain(
    `let set = BTreeSet::from([1]);
    let map = BTreeMap::from([(1, 2)]);
    println!("{} {} {}", same(&set, &set), precedes(&map, &map), BTreeSet::<f64>::new() == BTreeSet::new());`,
    `use std::collections::{BTreeMap, BTreeSet};
      fn same<K: PartialEq>(a: &BTreeSet<K>, b: &BTreeSet<K>) -> bool { a == b }
      fn precedes<K: PartialOrd, V: PartialOrd>(a: &BTreeMap<K, V>, b: &BTreeMap<K, V>) -> bool { a < b }`
  );
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: 'true false true\n' });
});

test('iterates borrowed Rust collections of boxed trait objects', () => {
  const program = rustMain(
    'let values: Vec<Box<dyn ToString>> = vec![Box::new(7)]; print_slice(&values); print_vec(&values);',
    `fn print_slice(values: &[Box<dyn ToString>]) {
        for value in values { println!("{}", value.to_string()); }
      }
      fn print_vec(values: &Vec<Box<dyn ToString>>) {
        for value in values { println!("{}", value.to_string()); }
      }`
  );
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: '7\n7\n' });
});

test('clones owned Rust iterator sources and peeked items with their own types', () => {
  const program = rustMain(`let mut pairs = vec![(1, "a"), (2, "b")].into_iter().enumerate().peekable();
    println!("{:?}", pairs.peek());
    let copy: Vec<_> = pairs.clone().collect();
    let original: Vec<_> = pairs.collect();
    println!("{:?} {:?}", copy, original);

    let zipped = (0..2).zip(vec!["x", "y"]);
    println!("{:?} {:?}", zipped.clone().collect::<Vec<_>>(), zipped.collect::<Vec<_>>());

    let flat = std::iter::once(vec![7]).chain(std::iter::once(vec![8])).flatten().enumerate();
    println!("{:?} {:?}", flat.clone().collect::<Vec<_>>(), flat.collect::<Vec<_>>());`);
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout:
      'Some((0, (1, "a")))\n' +
      '[(0, (1, "a")), (1, (2, "b"))] [(0, (1, "a")), (1, (2, "b"))]\n' +
      '[(0, "x"), (1, "y")] [(0, "x"), (1, "y")]\n' +
      '[(0, 7), (1, 8)] [(0, 7), (1, 8)]\n',
  });
});

test('reborrows Rust closure captures for generic and boxed callable arguments', () => {
  const wrap = `let mut value = 0;
    let reference = &mut value;
    let mut run = || callback(reference);
    run();
    run();
    println!("{}", value);`;
  for (const kind of ['Fn', 'FnMut']) {
    const header = kind === 'FnMut' ? 'mut callback' : 'callback';
    const program = rustMain('wrap(|value| *value += 1);', `fn wrap<F: ${kind}(&mut i32)>(${header}: F) { ${wrap} }`);
    expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: '2\n' });
  }
  const boxed = rustMain(`let callback: Box<dyn Fn(&mut i32)> = Box::new(|value: &mut i32| *value += 1); ${wrap}`);
  expect(executeProgram('rust', boxed)).toMatchObject({ kind: 'executed', stdout: '2\n' });
});

test('imports Rust block items and aliases through their lexical scopes', () => {
  const program = rustMain(`use String as Text;
    use Text as Label;
    struct Pair(i32);
    use Pair as Local;
    {
      use Label as Caption;
      use Local as Counter;
      let count = Counter(3);
      println!("{} {}", Caption::from("count"), count.0);
    }`);
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: 'count 3\n' });
  expect(executeProgram('rust', rustMain('struct Local; { pub use Local as Public; }')).kind).toBe('compileError');
  expect(executeProgram('rust', rustMain('use B as A; use A as B;')).kind).toBe('compileError');
});

test('instantiates the item type of a Rust generic opaque iterator at each call', () => {
  const program = `fn main() {
      let numbers = reversed(vec![1, 2]);
      println!("{:?}", numbers.collect::<Vec<_>>());
      for ch in iterable(vec!['a', 'b']) { println!("{}", ch); }
      let selected = if true { reversed(vec![3]) } else { reversed(vec![4]) };
      println!("{:?}", selected.collect::<Vec<_>>());
    }
    fn reversed<T>(items: Vec<T>) -> impl Iterator<Item = T> { items.into_iter().rev() }
    fn iterable<T>(items: Vec<T>) -> impl IntoIterator<Item = T> { items }`;
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: '[2, 1]\na\nb\n[3]\n' });
});

test('uses Rust Zip indexed formatting only when its owned elements are Copy', () => {
  const program = rustMain(`let mut pairs = vec![1, 2, 3].into_iter().zip(vec!["a", "b", "c"]);
    pairs.next();
    println!("{:?} {:?} {}", pairs, [1, 2].into_iter().zip([3, 4]), pairs.clone().count());
    println!("{:?}", vec![String::from("a")].into_iter().zip(vec![1]));
    println!("{:?}", vec![1].into_iter().map(|n| n + 1).zip([2]));`);
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: 'Zip Zip 2\nZip { a: IntoIter(["a"]), b: IntoIter([1]) }\nZip\n',
  });
});

test('validates Rust generic constants reached through trait objects', () => {
  const declarations = `struct S<T>(T);
    impl<T> S<T> { const BAD: i8 = 127_i8.pow(2); }
    trait Read { fn read(&self) -> i8; }
    trait Sub: Read {}
    impl<T> Read for S<T> { fn read(&self) -> i8 { Self::BAD } }
    impl<T> Sub for S<T> {}
    fn bad<T>() -> i8 { S::<T>::BAD }`;
  for (const body of [
    'let object: Box<dyn Sub> = Box::new(S(1)); println!("before"); println!("{}", object.read());',
    'let value = S(1); let object: &dyn Read = &value; println!("{}", object.read());',
    'let bad = bad::<i32>; println!("{}", bad());',
  ]) {
    expect(executeProgram('rust', rustMain(body, declarations)).kind).toBe('compileError');
  }
  const unused = rustMain('let _value = S(1); let _function = bad::<i32>;', declarations);
  expect(executeProgram('rust', unused)).toMatchObject({ kind: 'executed', stdout: '' });
});

test('validates Rust constant match coverage before evaluating a referenced initializer', () => {
  const invalid = [
    'const X: i32 = match true { false => 1 };',
    'const X: i32 = match false { true => 1 }; const Y: i32 = X;',
  ];
  expect(executeProgram('rust', rustMain('println!("main");', invalid[0]))).toMatchObject({
    kind: 'compileError',
    diagnostics: [expect.objectContaining({ message: expect.stringContaining('match') })],
  });
  expect(executeProgram('rust', rustMain('match 1 { Y => (), _ => () }', invalid[1]))).toMatchObject({
    kind: 'compileError',
    diagnostics: [expect.objectContaining({ message: expect.stringContaining('match') })],
  });
  const valid = rustMain(
    'println!("{}", X);',
    'const YES: bool = 1_i32.abs() == 1; const X: i32 = match true { false => 0, YES => 2 };'
  );
  expect(executeProgram('rust', valid)).toMatchObject({ kind: 'executed', stdout: '2\n' });
});

test('reborrows Rust references through value-producing argument expressions', () => {
  for (const [argument, expected] of [
    ['{ print!("arg "); reference }', 'arg arg 2\n'],
    ['if choose { reference } else { reference }', '2\n'],
    ['match choose { true => { reference }, false => reference }', '2\n'],
  ]) {
    const program = rustMain(
      'wrap(true, |value| *value += 1);',
      `fn wrap<F: Fn(&mut i32)>(choose: bool, callback: F) {
        let mut value = 0;
        let reference = &mut value;
        let mut run = || callback(${argument});
        run();
        run();
        println!("{}", value);
      }`
    );
    expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: expected });
  }
  const moved = rustMain(
    'let mut n = 0; let reference = &mut n; take({ reference }); take(reference);',
    'fn take<T>(_: T) {}'
  );
  expect(executeProgram('rust', moved).kind).toBe('compileError');
});

test('propagates Rust repeated const elements without inventing destructors', () => {
  const valid = rustMain(
    'println!("ok");',
    'const N: Option<String> = None; const X: () = { let values = ([None::<String>; 1], [N; 2]); };'
  );
  expect(executeProgram('rust', valid)).toMatchObject({ kind: 'executed', stdout: 'ok\n' });
  const invalid = rustMain('', 'const X: () = { let values = [Some(String::new()); 1]; };');
  expect(executeProgram('rust', invalid).kind).toBe('compileError');
});

test('infers extend literals from Rust collection element types', () => {
  const program = rustMain(`let mut wide: Vec<i64> = Vec::new();
    wide.extend([1, 2]);
    wide.extend(&[3, 4]);
    let mut bytes: Vec<u8> = Vec::new();
    bytes.extend(vec![b'a', 66]);
    let mut floats: Vec<f32> = Vec::new();
    floats.extend([1.5, 2.0]);
    let mut set: std::collections::HashSet<u64> = std::collections::HashSet::new();
    set.extend(0..3);
    println!("{:?} {:?} {:?} {}", wide, bytes, floats, set.len());`);
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: '[1, 2, 3, 4] [97, 66] [1.5, 2.0] 3\n',
  });
  const explicit = rustMain('let mut values: Vec<u8> = Vec::new(); values.extend([1_i32]);');
  expect(executeProgram('rust', explicit).kind).toBe('compileError');
});

test('coerces Rust collection elements and branch results at the correct sites', () => {
  const items = `trait Read { fn read(&self) -> i32; }
    struct A; struct B;
    impl Read for A { fn read(&self) -> i32 { 1 } }
    impl Read for B { fn read(&self) -> i32 { 2 } }`;
  const valid = rustMain(
    `let values = vec![(1, Box::new(A) as Box<dyn Read>), (2, Box::new(B))];
    let refs = [(1, &A as &dyn Read), (2, &B)];
    let choice: Option<Box<dyn Read>> = if true { Some(Box::new(A)) } else { Some(Box::new(B)) };
    println!("{} {} {}", values[1].1.read(), refs[1].1.read(), choice.unwrap().read());`,
    items
  );
  expect(executeProgram('rust', valid)).toMatchObject({ kind: 'executed', stdout: '2 2 1\n' });
  for (const body of [
    'let _ = match 1 { 0 => Some(Box::new(A) as Box<dyn Read>), _ => Some(Box::new(B)) };',
    'let _ = if true { (0, Box::new(A) as Box<dyn Read>) } else { (1, Box::new(B)) };',
  ]) {
    expect(executeProgram('rust', rustMain(body, items)).kind).toBe('compileError');
  }
});

test('keeps the capacities of equal Rust strings through aggregate construction and moves', () => {
  const declarations = `struct Pair { a: String, b: String }
    fn pair() -> (String, String) { (String::with_capacity(8), String::with_capacity(16)) }
    fn print(a: String, b: String) { println!("{} {}", a.capacity(), b.capacity()); }`;
  const program = rustMain(
    `let fields = Pair { b: String::with_capacity(9), a: String::with_capacity(4) };
    println!("{} {}", fields.a.capacity(), fields.b.capacity());
    let mut values = vec![String::new(), String::with_capacity(10)];
    values.swap(0, 1);
    println!("{} {}", values[0].capacity(), values[1].capacity());
    let (a, b) = pair();
    print(a, b);
    print(String::with_capacity(2), String::with_capacity(3));

    let mut data = String::with_capacity(12);
    data.push_str("ab");
    data.as_mut_str().make_ascii_uppercase();
    let copy = data.clone();
    println!("{} {} {} {} {:?}", data, data.capacity(), copy.capacity(), data == "AB", &data[..1]);
    let bytes = data.into_bytes();
    println!("{}", bytes.capacity());
    let restored = String::from_utf8(bytes).unwrap();
    println!("{} {}", restored, restored.capacity());`,
    declarations
  );
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: '4 9\n10 0\n8 16\n2 3\nAB 12 2 true "A"\n12\nAB 12\n',
  });
});

test('preserves Rust Zip callback order for owned Copy sources', () => {
  const program = rustMain(`let mut zipped = (0..10).map(|n| { println!("n{}", n); n }).zip([1, 2]);
    for _ in 0..3 { println!("{:?}", zipped.next()); }`);
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: 'n0\nSome((0, 1))\nn1\nSome((1, 2))\nn2\nNone\n',
  });
});

test('preserves Rust String capacity when splicing vectors', () => {
  const program = rustMain(`let mut a = String::with_capacity(10);
    a.push('a');
    let mut b = String::with_capacity(20);
    b.push('b');
    let mut values = vec![a, b];
    let first: Vec<_> = values.drain(..1).collect();
    println!("{} {}", first[0].capacity(), values[0].capacity());
    let mut remaining = values.split_off(0);
    let last = remaining.pop().unwrap();
    println!("{} {}", last, last.capacity());`);
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: '10 20\nb 20\n' });
});

test('reborrows Rust references in breaks that supply a loop argument', () => {
  const program = rustMain(
    'wrap(|value| *value += 1);',
    `fn wrap<F: Fn(&mut i32)>(callback: F) {
       let mut value = 0;
       let reference = &mut value;
       let mut run = || callback('outer: loop {
         loop { break; }
         loop { break 'outer { reference }; }
       });
       run();
       run();
       println!("{}", value);
     }`
  );
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: '2\n' });
});

test('checks Rust const array overwrites and zero-length drops', () => {
  for (const initializer of [
    '{ let mut values = [N; 2]; values[0] = Some(String::new()); }',
    '{ let mut values = ([N; 2],); values.0[1_i32.abs() as usize] = None; }',
    '{ let values = [Some(String::new()); 0]; }',
    '{ let values = [String::new(); 0]; }',
  ]) {
    const items = `const N: Option<String> = None; const X: () = ${initializer};`;
    const source = rustMain('', items);
    expect(executeProgram('rust', source)).toMatchObject({
      kind: 'compileError',
      diagnostics: [expect.objectContaining({ message: expect.stringContaining('破棄') })],
    });
  }
  const declarations = `const TEXT: String = String::new(); const EMPTY: [String; 0] = [TEXT; 0];
    struct S<T>(T);
    impl<T> S<T> { const BAD: i8 = 127_i8.pow(2); }`;
  const valid = rustMain('let empty = [S::<i32>::BAD; 0]; println!("{} {}", EMPTY.len(), empty.len());', declarations);
  expect(executeProgram('rust', valid)).toMatchObject({ kind: 'executed', stdout: '0 0\n' });
});

test('evaluates Rust repeated constants before each owned array element is used', () => {
  const program = rustMain(
    `let mut vectors = [EMPTY; 2];
    vectors[0].push(1);
    let mut options = [OPTION; 2];
    options[0].as_mut().unwrap().push(2);
    let grid = GRID;
    println!("{:?} {:?} {} {:?}", vectors, options, GRID[1], grid);`,
    `const SIZE: usize = 3;
      const GRID: [i32; SIZE] = [0; SIZE];
      const EMPTY: Vec<i32> = Vec::new();
      const OPTION: Option<Vec<i32>> = Some(Vec::new());`
  );
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: '[[1], []] [Some([2]), Some([])] 0 [0, 0, 0]\n',
  });
});

test('formats opaque Rust trait results using the dispatched method', () => {
  const source = rustMain(
    'show(DefaultName); show(NumberName(4));',
    `use std::fmt::{Debug, Display};
     trait Name {
       fn label(&self) -> impl Display { "default" }
       fn items(&self) -> impl Debug;
     }
     struct DefaultName;
     impl Name for DefaultName { fn items(&self) -> impl Debug { vec![1, 2] } }
     struct NumberName<T>(T);
     impl<T: Display + Debug + Copy> Name for NumberName<T> {
       fn label(&self) -> impl Display { self.0 }
       fn items(&self) -> impl Debug { [self.0] }
     }
     fn show<T: Name>(name: T) {
       println!("{} {:?} {:?}", name.label(), name.items(), Some(name.items()));
     }`
  );
  expect(executeProgram('rust', source)).toMatchObject({
    kind: 'executed',
    stdout: 'default [1, 2] Some([1, 2])\n4 [4] Some([4])\n',
  });
});

test('preserves exact Rust iterator lengths and indexes beyond the host safe integer range', () => {
  const source = rustMain(`let n = usize::MAX;
    println!("{} {}", (0usize..n).len(), (0isize..isize::MAX).len());
    println!("{} {} {}", (0usize..n).skip(n - 3).len(), (0usize..n).take(n - 1).len(), (0usize..n).step_by(2).len());
    println!("{:?}", (0usize..n).enumerate().next_back());`);
  expect(executeProgram('rust', source)).toMatchObject({
    kind: 'executed',
    stdout:
      '18446744073709551615 9223372036854775807\n3 18446744073709551614 9223372036854775808\nSome((18446744073709551614, 18446744073709551614))\n',
  });
});

test('matches Rust inclusive range endpoints and reports unbounded char overflow', () => {
  const source = rustMain(String.raw`let mut forward = 1..=1;
    let mut backward = 1..=1;
    println!("{:?} {:?} {} {}", forward.next(), forward, forward.start(), forward.end());
    println!("{:?} {:?} {} {}", backward.next_back(), backward, backward.start(), backward.end());
    let mut last = u8::MAX..=u8::MAX;
    println!("{:?} {:?}", last.next(), last);
    println!("{:?}", last.next());
    let mut first = u8::MIN..=u8::MIN;
    println!("{:?} {:?}", first.next_back(), first);
    let mut last_char = '\u{10ffff}'..='\u{10ffff}';
    println!("{:?} {:?}", last_char.next(), last_char);`);
  expect(executeProgram('rust', source)).toMatchObject({
    kind: 'executed',
    stdout:
      "Some(1) 2..=1 2 1\nSome(1) 1..=0 1 0\nSome(255) 0..=255 (exhausted)\nNone\nSome(0) 0..=255 (exhausted)\nSome('\\u{10ffff}') '\\u{10ffff}'..='\\u{10ffff}' (exhausted)\n",
  });
  const overflow = rustMain(String.raw`let mut range = '\u{10fffe}'..;
    println!("{:?}", range.next()); range.next();`);
  expect(executeProgram('rust', overflow)).toMatchObject({
    kind: 'executed',
    stdout: "Some('\\u{10fffe}')\n",
    uncaughtException: expect.stringContaining('library/core/src/iter/range.rs:118:45:\noverflow in `Step::forward`'),
  });
});

test('rounds Rust f32 division before truncating its Euclidean quotient', () => {
  const source = rustMain(`println!("{} {} {} {}", 5_f32.div_euclid(0.1), 1_f32.div_euclid(0.1),
    (-5_f32).div_euclid(0.1), 5_f64.div_euclid(0.1));`);
  expect(executeProgram('rust', source)).toMatchObject({ kind: 'executed', stdout: '50 10 -51 50\n' });
});

test('matches Rust zip callback order when extending a vector and a string', () => {
  const source = rustMain(`let mut values = Vec::new();
    values.extend((0..3).map(|n| { print!("{}", n); n }).zip(vec![String::from("a"), String::from("b")]));
    println!(" {:?}", values);
    let mut text = String::new();
    text.extend(('a'..'d').map(|c| { print!("{}", c); c })
      .zip(vec![String::from("a"), String::from("b")]).map(|pair| pair.0));
    println!(" {}", text);`);
  expect(executeProgram('rust', source)).toMatchObject({
    kind: 'executed',
    stdout: '01 [(0, "a"), (1, "b")]\nab ab\n',
  });
});

test('keeps Rust expressions before block items in statement position', () => {
  for (const expression of ['if true { 1 } else { 2 }', 'match true { true => 1, false => 2 }']) {
    const source = rustMain(`let _value = { ${expression} fn helper() {} };`);
    expect(executeProgram('rust', source)).toMatchObject({
      kind: 'compileError',
      diagnostics: [expect.objectContaining({ message: expect.stringContaining('型が合いません') })],
    });
  }
  const valid = rustMain(`let value = { if true { print!("one "); } fn helper() {} };
    println!("{:?}", value);`);
  expect(executeProgram('rust', valid)).toMatchObject({ kind: 'executed', stdout: 'one ()\n' });
});

test('rejects a duplicate or noninitial Rust receiver parameter', () => {
  for (const parameters of ['&self, &self', 'value: i32, &self']) {
    const source = rustMain('', `struct Item; impl Item { fn method(${parameters}) {} }`);
    expect(executeProgram('rust', source)).toMatchObject({ kind: 'compileError' });
  }
});

test('independently advances and formats cloned Rust leaf iterators', () => {
  const source = rustMain(`let mut chars = "éabc".char_indices();
    chars.next();
    let mut copy = chars.clone();
    copy.next(); copy.next_back();
    chars.next_back(); chars.next_back(); chars.next_back();
    println!("{:?} {:?}", chars, copy);
    let array = [1, 2, 3];
    let windows = array.windows(2);
    let mut copy = windows.clone();
    copy.next();
    println!("{:?} {:?}", windows, copy);
    let some = Some(1);
    let option = some.iter();
    let mut copy = option.clone();
    copy.next();
    println!("{:?} {:?}", option, copy);`);
  expect(executeProgram('rust', source)).toMatchObject({
    kind: 'executed',
    stdout:
      "CharIndices { front_offset: 2, iter: Chars([]) } CharIndices { front_offset: 3, iter: Chars(['b']) }\n" +
      'Windows { v: [1, 2, 3], size: 2 } Windows { v: [2, 3], size: 2 }\n' +
      'Iter { inner: Item { opt: Some(1) } } Iter { inner: Item { opt: None } }\n',
  });
});

test('clones partially consumed Rust BTreeSet operations without sharing progress', () => {
  const source = rustMain(
    `let left = BTreeSet::from([1, 2, 4, 6, 7]);
    let right = BTreeSet::from([2, 3, 4, 8]);
    let mut union = left.union(&right);
    union.next();
    let mut union_clone = union.clone();
    println!("{:?} {:?} {:?} {:?}", union.next(), union.next(), union_clone.next(), union_clone.next());
    let mut difference = left.difference(&right);
    difference.next();
    let mut difference_clone = difference.clone();
    println!("{:?} {:?}", difference.next(), difference_clone.next());
    let mut intersection = left.intersection(&right);
    intersection.next();
    let mut intersection_clone = intersection.clone();
    println!("{:?} {:?}", intersection.next(), intersection_clone.next());
    let mut symmetric = left.symmetric_difference(&right);
    symmetric.next();
    let mut symmetric_clone = symmetric.clone();
    println!("{:?} {:?}", symmetric.next(), symmetric_clone.next());`,
    'use std::collections::BTreeSet;'
  );
  expect(executeProgram('rust', source)).toMatchObject({
    kind: 'executed',
    stdout: 'Some(2) Some(3) Some(2) Some(3)\nSome(6) Some(6)\nSome(4) Some(4)\nSome(3) Some(3)\n',
  });
});

test('Rust repeat_n moves its last element and does not clone when empty or exhausted', () => {
  const source = rustMain(
    `let mut empty = std::iter::repeat_n(Item(0), 0);
    let _copy = empty.clone();
    assert!(empty.next().is_none());
    let mut values = std::iter::repeat_n(Item(7), 3);
    println!("{} {} {}", values.next_back().unwrap().0, values.next().unwrap().0, values.next_back().unwrap().0);
    let _copy = values.clone();
    assert!(values.next().is_none());
    println!("{}", std::iter::repeat_n(Item(9), 1).next().unwrap().0);`,
    `struct Item(i32);
      impl Clone for Item {
        fn clone(&self) -> Self { print!("clone "); Item(self.0) }
      }`
  );
  expect(executeProgram('rust', source)).toMatchObject({ kind: 'executed', stdout: 'clone clone 7 7 7\n9\n' });
});

test('cycles a Rust iterator whose state is cloneable and whose output is move-only', () => {
  const source = rustMain(
    `let values: Vec<_> = (0..2).map(Item).cycle().take(4).map(|value| value.0).collect();
    println!("{:?}", values);`,
    'struct Item(i32);'
  );
  expect(executeProgram('rust', source)).toMatchObject({ kind: 'executed', stdout: '[0, 1, 0, 1]\n' });
  for (const iterator of [
    '[Item(0)].into_iter()',
    'vec![Item(0)].into_iter().map(|value| value.0)',
    '(0..2).map(Item).peekable()',
    'std::iter::once(Item(0))',
  ]) {
    const invalid = rustMain(`let _values = ${iterator}.cycle();`, 'struct Item(i32);');
    expect(executeProgram('rust', invalid)).toMatchObject({ kind: 'compileError' });
  }
});

test('uses Rust blanket conversions and their correct result error types', () => {
  const source = rustMain(
    `let value: Result<f64, Infallible> = f64::try_from(3_i32);
    let number: f32 = 5_i16.try_into().unwrap();
    let record: Result<Record, Infallible> = Record::try_from(3_i32);
    let items = VecDeque::try_from(vec![1, 2]).unwrap();
    println!("{:?} {:?} {} {:?}", value, number, record.unwrap().0, items);
    println!("{:?} {:?} {:?}", bool::try_from(0_u8), bool::try_from(1_u32), bool::try_from(-1_i16));`,
    `use std::collections::VecDeque;
     use std::convert::Infallible;
     struct Record(i32);
     impl From<i32> for Record { fn from(value: i32) -> Self { Record(value + 1) } }`
  );
  expect(executeProgram('rust', source)).toMatchObject({
    kind: 'executed',
    stdout: 'Ok(3.0) 5.0 4 [1, 2]\nOk(false) Ok(true) Err(TryFromIntError(NegOverflow))\n',
  });
  const invalid = rustMain('let _: f64 = 3_u64.try_into().unwrap();');
  expect(executeProgram('rust', invalid)).toMatchObject({ kind: 'compileError' });
});

test('applies explicit type arguments to Rust trait-qualified methods and function values', () => {
  const items = `trait Maker { fn make<T: Default>(&self) -> T { T::default() } }
    struct Source;
    impl Maker for Source {}`;
  const source = rustMain(
    `let make = Maker::make::<i64>;
    println!("{} {}", Maker::make::<i64>(&Source), make(&Source));`,
    items
  );
  expect(executeProgram('rust', source)).toMatchObject({ kind: 'executed', stdout: '0 0\n' });
  const invalid = rustMain('let _made: i32 = Maker::make::<String>(&Source);', items);
  expect(executeProgram('rust', invalid)).toMatchObject({ kind: 'compileError' });
});

test('uses Rust integer cast widths in direct, named, and repeated array lengths', () => {
  const source = rustMain(
    `let empty: [i32; (256_u16 as u8) as usize] = [];
    let a: [i32; N] = [7, 8];
    let b = [1; ((-254_i16) as u8) as usize];
    println!("{} {:?} {:?}", empty.len(), a, b);`,
    'const N: usize = (258_u16 as u8) as usize;'
  );
  expect(executeProgram('rust', source)).toMatchObject({ kind: 'executed', stdout: '0 [7, 8] [1, 1]\n' });
});

test('checks supertraits and Copy fields of manual Rust trait implementations', () => {
  for (const items of [
    '#[derive(Clone)] struct Item(String); impl Copy for Item {}',
    '#[derive(Clone)] enum Item<T> { Empty, Value(T) } impl<T: Clone> Copy for Item<T> {}',
    'trait Parent<T> {} trait Child: Parent<i32> {} struct Item; impl Parent<bool> for Item {} impl Child for Item {}',
    'struct Item; impl Eq for Item {}',
  ]) {
    expect(executeProgram('rust', rustMain('', items))).toMatchObject({ kind: 'compileError' });
  }
  const valid = rustMain(
    `let previous = Item::Value(3);
    let next = previous;
    println!("{:?} {:?}", previous, next);`,
    '#[derive(Debug, Clone)] enum Item<T> { Value(T) } impl<T: Copy> Copy for Item<T> {}'
  );
  expect(executeProgram('rust', valid)).toMatchObject({ kind: 'executed', stdout: 'Value(3) Value(3)\n' });
});

test('solves Rust blanket trait implementations for generic forwarding', () => {
  const source = rustMain(
    'forward(1); forward_bounded(2);',
    `use std::fmt::Debug;
      trait Mark {}
      trait DebugMark { fn marked(&self) -> i32 { 2 } }
      impl<T> Mark for T {}
      impl<T: Debug> DebugMark for T {}
      fn take<T: Mark>(_: T) { println!("ok"); }
      fn forward<T>(value: T) { take(value); }
      fn forward_bounded<T: Debug>(value: T) { println!("{}", value.marked()); }`
  );
  expect(executeProgram('rust', source)).toMatchObject({ kind: 'executed', stdout: 'ok\n2\n' });
});

test('shows exhausted Rust ranges inside iterator Debug output', () => {
  const source = rustMain(`let mut reverse = (0_u8..=0).rev();
    reverse.next();
    println!("{:?}", reverse);
    let mut fused = (255_u8..=255).fuse();
    fused.next();
    println!("{:?}", fused);`);
  expect(executeProgram('rust', source)).toMatchObject({
    kind: 'executed',
    stdout: 'Rev { iter: 0..=255 (exhausted) }\nFuse { iter: Some(0..=255 (exhausted)) }\n',
  });
});

test('dispatches Rust trait impls by nested trait-object type arguments', () => {
  const source = rustMain(
    `let x: Box<dyn P<i32>> = Box::new(Source);
    let y: Box<dyn P<bool>> = Box::new(Source);
    println!("{} {}", later(x), later(y));`,
    `trait P<T> { fn f(&self) -> i32; }
      struct Source;
      impl P<i32> for Source { fn f(&self) -> i32 { 1 } }
      impl P<bool> for Source { fn f(&self) -> i32 { 2 } }
      trait A { fn a(&self) -> i32; }
      impl A for Box<dyn P<i32>> { fn a(&self) -> i32 { 10 } }
      impl A for Box<dyn P<bool>> { fn a(&self) -> i32 { 20 } }
      fn later<T: A>(value: T) -> i32 { value.a() }`
  );
  expect(executeProgram('rust', source)).toMatchObject({ kind: 'executed', stdout: '10 20\n' });
});

test('uses Rust tokens for matches separators and macro expression diagnostics', () => {
  const predicates = rustMain(
    `println!("{} {} {} {}",
    matches!(',', ','),
    matches!('(', '('),
    matches!(/* , */ 1, 1),
    matches!(pair::<i32, bool>(), (1, true), /* trailing comma */));`,
    'fn pair<A: From<i32>, B: From<bool>>() -> (A, B) { (A::from(1), B::from(true)) }'
  );
  expect(executeProgram('rust', predicates)).toMatchObject({ kind: 'executed', stdout: 'true true true true\n' });
  const formatted = rustMain(`dbg!("a   b"); dbg!(1/* skip */+2);
    assert!(false   || "a   b".is_empty());`);
  const result = executeProgram('rust', formatted);
  expect(result).toMatchObject({
    kind: 'executed',
    stderr: expect.stringContaining('"a   b" = "a   b"'),
    uncaughtException: expect.stringContaining('assertion failed: false || "a   b".is_empty()'),
  });
  expect(result).toMatchObject({ stderr: expect.stringContaining('1 +2 = 3') });
});

test('reports unavailable Rust standard associated items and preserves user diagnostics', () => {
  for (const call of ['String::from_utf16(&[104_u16])', 'std::collections::hash_map::Entry::Vacant']) {
    const source = rustMain(`let _value = ${call};`);
    expect(executeProgram('rust', source)).toMatchObject({
      kind: 'compileError',
      diagnostics: [expect.objectContaining({ message: expect.stringContaining('この採点環境では使えません') })],
    });
  }
  const user = rustMain('let _value = User::missing();', 'struct User;');
  expect(executeProgram('rust', user)).toMatchObject({
    kind: 'compileError',
    diagnostics: [expect.objectContaining({ message: expect.stringContaining('関連関数 missing がありません') })],
  });
});

test('formats the residual Rust window slice after a clone exhausts from either end', () => {
  const source = rustMain(`let array = [1, 2, 3];
    let windows = array.windows(2);
    let mut forward = windows.clone();
    forward.next(); forward.next();
    let mut mixed = windows.clone();
    mixed.next(); mixed.next_back();
    println!("{:?} {:?} {:?}", windows, forward, mixed);`);
  expect(executeProgram('rust', source)).toMatchObject({
    kind: 'executed',
    stdout: 'Windows { v: [1, 2, 3], size: 2 } Windows { v: [3], size: 2 } Windows { v: [2], size: 2 }\n',
  });
});

test('grows Rust String buffers with reference collection and replacement capacities', () => {
  const source = rustMain(`println!("{} {} {} {} {}",
      "hello".chars().collect::<String>().capacity(),
      "hello".replace("l", "LL").capacity(),
      "hello world".chars().rev().collect::<String>().capacity(),
      (0..5).map(|i| i.to_string()).collect::<String>().capacity(),
      ["ab","cd"].iter().map(|s| s.to_string()).collect::<String>().capacity());
    println!("{} {} {} {}", "hello".replace("l", "q").capacity(),
      "hello".replacen("l", "LL", 1).capacity(),
      "hello".chars().filter(|c| *c != 'l').collect::<String>().capacity(),
      vec!['a'; 12].iter().collect::<String>().capacity());
    println!("{:?} {:?}", "abc".replace("", "-"), "abc".replacen("", "-", 1));
    let mut initial = String::with_capacity(24);
    initial.push('é');
    let text: String = [initial, String::from("b")].into_iter().collect();
    println!("{} {} {}", text, text.len(), text.capacity());`);
  expect(executeProgram('rust', source)).toMatchObject({
    kind: 'executed',
    stdout: '8 10 16 10 8\n5 32 8 12\n"-a-b-c-" "-abc"\néb 3 24\n',
  });
});

test('appends repeatedly to a Rust String within the execution budget', () => {
  const source = rustMain(`let mut text = String::new();
    while text.len() < 60000 { text.push_str("é"); }
    println!("{} {}", text.len(), text.chars().count());`);
  expect(executeProgram('rust', source)).toMatchObject({ kind: 'executed', stdout: '60000 30000\n' });
});

test('rounds Rust fused multiply-add once at its receiver width', () => {
  const source = rustMain(`let a = 1.0000001192092896_f32 / 4096.0;
    let b = 0.9999998807907104_f32 / 4096.0;
    println!("{:?} {:?} {:?} {}", a.mul_add(b, 1.0000001192092896_f32),
      a.mul_add(b, 1.0000003576278687_f32),
      f32::MIN_POSITIVE.mul_add(0.5, 0.0),
      1e308_f64.mul_add(1e308, f64::NEG_INFINITY));`);
  expect(executeProgram('rust', source)).toMatchObject({
    kind: 'executed',
    stdout: '1.0000001 1.0000004 5.877472e-39 -inf\n',
  });
});

test('reuses destination Rust buffers and dispatches custom clone_from on slices', () => {
  const source = rustMain(
    `let mut strings = [String::from("xxxx"), String::with_capacity(12)];
    strings.clone_from_slice(&[String::from("a"), String::from("abc")]);
    println!("{} {} {} {}", strings[0], strings[0].capacity(), strings[1], strings[1].capacity());
    let mut vector = Vec::with_capacity(12);
    vector.push(String::from("old content"));
    let mut destination = [vector];
    destination.clone_from_slice(&[vec![String::from("new"), String::from("later")]]);
    println!("{} {} {:?}", destination[0].capacity(), destination[0][0].capacity(), destination[0]);
    let mut own = [Item(1)];
    own.clone_from_slice(&[Item(7)]);
    println!("{}", own[0].0);`,
    `struct Item(i32);
     impl Clone for Item {
       fn clone(&self) -> Self { print!("clone "); Item(self.0) }
       fn clone_from(&mut self, source: &Self) { print!("clone_from "); self.0 = source.0; }
     }`
  );
  expect(executeProgram('rust', source)).toMatchObject({
    kind: 'executed',
    stdout: 'a 4 abc 12\n12 11 ["new", "later"]\nclone_from 7\n',
  });
});

test('keeps Rust move predicates reachable through string iterators', () => {
  for (const [method, argumentsBeforePredicate] of [
    ['split', ''],
    ['matches', ''],
    ['splitn', '2, '],
  ]) {
    const source = rustMain(`let observer = Turtle::new(0, 0);
      let mut turtle = Turtle::new(0, 1);
      let mut pieces = "a,b".${method}(${argumentsBeforePredicate}move |c| { turtle.turn_right(); c == ',' });
      println!("{}", observer.canMoveForward());
      pieces.next();
      println!("{}", observer.canMoveForward());`);
    expect(executeProgram('rust', source)).toMatchObject({ kind: 'executed', stdout: 'false\nfalse\n' });
  }
});

test('retains exact Rust splitn counts in clones', () => {
  const source = rustMain(`let mut parts = "a,b".splitn(usize::MAX, ',');
    parts.next();
    let mut reverse = "a,b".rsplitn(9007199254740993_usize, ',');
    reverse.next();
    println!("{:?} {:?}", parts.clone(), reverse.clone());`);
  const result = executeProgram('rust', source);
  expect(result).toMatchObject({ kind: 'executed', stdout: expect.stringContaining('count: 18446744073709551614') });
  expect(result).toMatchObject({ stdout: expect.stringContaining('count: 9007199254740992') });
});

test('uses Rust layouts for function items, coerced pointers, and closure captures', () => {
  const source = rustMain(
    `let number = 30_i64;
    let moved = move || number;
    let borrowed = || number;
    let pointer = if true { first } else { second };
    println!("{} {} {} {} {} {}", layout(first), layout(Record), layout(pointer),
      layout(moved), layout(borrowed), generic_capture(1_u16));`,
    `struct Record(i32);
     fn first() {}
     fn second() {}
     fn layout<T>(_: T) -> usize { std::mem::size_of::<T>() }
     fn generic_capture<T>(value: T) -> usize { layout(move || value) }`
  );
  expect(executeProgram('rust', source)).toMatchObject({ kind: 'executed', stdout: '0 0 8 8 8 2\n' });
});

test('copies adjusted Rust by-value method receivers reached through references', () => {
  const source = rustMain(
    `let shared = Item { value: 1 };
    let mut mutable = Item { value: 2 };
    let boxed = Box::new(Item { value: 3 });
    (&shared).overwrite();
    (&mut mutable).overwrite();
    (&boxed).overwrite();
    println!("{} {} {}", shared.value, mutable.value, boxed.value);`,
    `#[derive(Clone, Copy)]
     struct Item { value: i32 }
     impl Item { fn overwrite(mut self) { self.value = 9; } }`
  );
  expect(executeProgram('rust', source)).toMatchObject({ kind: 'executed', stdout: '1 2 3\n' });
});

test('bulk-rebuilds extended Rust heaps and copies borrowed collection elements', () => {
  const source = rustMain(
    `let mut h = BinaryHeap::new();
    h.extend([1, 2, 3, 4]);
    println!("{:?}", h.into_vec());
    let mut source = [Item(1)];
    let mut h: BinaryHeap<Item> = BinaryHeap::new();
    let mut t: BTreeSet<Item> = BTreeSet::new();
    let mut s: HashSet<Item> = HashSet::new();
    h.extend(source.iter()); t.extend(source.iter()); s.extend(source.iter());
    source[0].0 = 9;
    println!("{:?} {:?} {:?}", h, t, s);`,
    `use std::collections::{BinaryHeap, BTreeSet, HashSet};
      #[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
      struct Item(i32);`
  );
  expect(executeProgram('rust', source)).toMatchObject({
    kind: 'executed',
    stdout: '[4, 2, 3, 1]\n[Item(1)] {Item(1)} {Item(1)}\n',
  });
});

test('keeps Rust comparison operands alive while evaluating the other argument', () => {
  for (const operator of ['==', '<']) {
    const source = rustMain(
      `let observer = Turtle::new(1, 1);
      let result = Holder(Turtle::new(1, 2)) ${operator} create(&observer);
      println!("{}", result);`,
      `struct Holder(Turtle);
       impl PartialEq for Holder { fn eq(&self, _: &Self) -> bool { true } }
       impl PartialOrd for Holder {
         fn partial_cmp(&self, _: &Self) -> Option<std::cmp::Ordering> { Some(std::cmp::Ordering::Less) }
       }
       fn create(observer: &Turtle) -> Holder {
         println!("{}", observer.can_move_forward());
         Holder(Turtle::new(5, 5))
       }`
    );
    expect(executeProgram('rust', source)).toMatchObject({ kind: 'executed', stdout: 'false\ntrue\n' });
  }
});

test('casts Rust scalar constants before using them as array lengths', () => {
  const source = rustMain(
    `let a: [i32; true as usize] = [7];
    let b: [i32; 1.9_f64 as usize] = [8];
    let c = [0; MARK as usize];
    let d = [0; (SCALE as u8) as usize];
    let e = [0; (-1.5_f32) as usize];
    println!("{} {} {} {} {}", a.len(), b.len(), c.len(), d.len(), e.len());`,
    "const MARK: char = 'a'; const SCALE: f32 = 1.99999999;"
  );
  expect(executeProgram('rust', source)).toMatchObject({ kind: 'executed', stdout: '1 1 97 2 0\n' });
});

test('checks Rust slice start bounds before subsequent range tests', () => {
  for (const [range, start] of [
    ['3..0', '3'],
    ['2..2', '2'],
    ['2..=2', '2'],
    ['usize::MAX..=usize::MAX', '18446744073709551615'],
  ]) {
    const source = rustMain(`let arr = [1]; let _ = &arr[${range}];`);
    expect(executeProgram('rust', source)).toMatchObject({
      kind: 'executed',
      uncaughtException: expect.stringContaining(`range start index ${start} out of range for slice of length 1`),
    });
  }
});

test('uses Rust generic iterator bounds for adapter state', () => {
  const source = rustMain(
    `println!("{:?} {:?}", cycle(0..2), backwards(0..3));`,
    `fn cycle<I: Iterator<Item = i32> + Clone>(i: I) -> Vec<i32> { i.cycle().take(4).collect() }
     fn backwards<I: DoubleEndedIterator<Item = i32>>(i: I) -> Vec<i32> { i.rev().collect() }`
  );
  expect(executeProgram('rust', source)).toMatchObject({
    kind: 'executed',
    stdout: '[0, 1, 0, 1] [2, 1, 0]\n',
  });
  for (const method of ['.rev()', '.cycle()']) {
    const invalid = rustMain('', `fn adapt<I: Iterator<Item = i32>>(i: I) { let _ = i${method}; }`);
    expect(executeProgram('rust', invalid)).toMatchObject({ kind: 'compileError' });
  }
});

test('uses both trait and method type arguments in Rust qualified paths', () => {
  const source = rustMain(
    `let c: char = std::convert::TryFrom::<u32>::try_from(0x41).unwrap();
    let n = Factory::<i32>::produce::<i64>(&Maker, 1);
    println!("{} {}", c, n);`,
    `trait Factory<T> { fn produce<U: Default>(&self, value: T) -> U { U::default() } }
     struct Maker;
     impl Factory<i32> for Maker {}`
  );
  expect(executeProgram('rust', source)).toMatchObject({ kind: 'executed', stdout: 'A 0\n' });
});

test('requires Debug on abstract Rust conversion errors before unwrapping', () => {
  for (const item of [
    'fn convert<T: TryFrom<i32>>(value: i32) -> T { T::try_from(value).unwrap() }',
    'fn convert<T: TryInto<f64>>(value: T) -> f64 { value.try_into().unwrap() }',
  ])
    expect(executeProgram('rust', rustMain('', item))).toMatchObject({ kind: 'compileError' });
  const source = rustMain(
    'println!("{}", convert::<f64>(7));',
    'fn convert<T: From<i32>>(value: i32) -> T { T::try_from(value).unwrap() }'
  );
  expect(executeProgram('rust', source)).toMatchObject({ kind: 'executed', stdout: '7\n' });
});

test('uses Rust key equality for hash candidates and retains it after deletion or cloning', () => {
  const source = rustMain(
    `let mut map = HashMap::new();
    map.insert(Key(1), 10);
    println!("{:?}", map.insert(Key(1), 20));
    let mut copy = map.clone();
    println!("{:?}", copy.remove(&Key(1)));
    println!("{:?}", copy.get(&Key(1)));
    println!("{:?}", map.get(&Key(1)));
    let mut set = HashSet::new();
    set.insert(Key(3));
    println!("{}", set.contains(&Key(3))); set.clear();
    println!("{}", set.contains(&Key(3)));`,
    `use std::collections::{HashMap, HashSet};
     #[derive(Clone, Hash, Eq)]
     struct Key(i32);
     impl PartialEq for Key {
       fn eq(&self, other: &Self) -> bool { print!("eq "); self.0 == other.0 }
     }`
  );
  expect(executeProgram('rust', source)).toMatchObject({
    kind: 'executed',
    stdout: 'eq Some(10)\neq Some(20)\nNone\neq Some(20)\neq true\nfalse\n',
  });
});

test('keeps Rust IndexMut borrows active through index and receiver argument evaluation', () => {
  const invalid = [
    'let mut v = vec![0, 1]; v[v.len() - 1] = 2;',
    'let mut v = vec![0, 1]; v[v.iter().count() - 1] += 2;',
    'let mut v = vec![0, 1]; let x = &mut v[v[1] as usize]; *x = 7;',
    'let mut v = vec![0, 1]; let r = &mut v; r[r.len() - 1] = 2;',
    'let mut g = vec![vec![1], vec![2]]; g[0].push(g[1][0]);',
    'let mut g = vec![vec![1], vec![2]]; g[0][g[0].len() - 1] = 2;',
    'let mut q = std::collections::VecDeque::from([1, 2]); q[q.len() - 1] = 3;',
  ];
  for (const statements of invalid) {
    expect(executeProgram('rust', rustMain(statements))).toMatchObject({
      kind: 'compileError',
      diagnostics: [expect.objectContaining({ message: expect.stringContaining('借りられて') })],
    });
  }
  const valid = rustMain(`let mut array = [1, 2];
    array[array.len() - 1] = 9;
    let mut v = vec![0, 1]; v[0] += v[1];
    v[0] = v[v.len() - 1];
    let mut g = vec![vec![1], vec![2]];
    let value = g[1][0]; g[0].push(value);
    println!("{:?} {:?} {:?}", array, v, g);`);
  expect(executeProgram('rust', valid)).toMatchObject({
    kind: 'executed',
    stdout: '[1, 9] [1, 1] [[1, 2], [2]]\n',
  });
});

test('reborrows mutable Rust references throughout typed value positions', () => {
  for (const value of ['{ r }', 'if true { r } else { r }', 'match true { true => r, false => r }']) {
    const source = rustMain(`let mut n = 0; let r = &mut n;
      let q: &mut i32 = ${value}; *q += 1; *r += 1; println!("{}", n);`);
    expect(executeProgram('rust', source)).toMatchObject({ kind: 'executed', stdout: '2\n' });
  }
  const source = rustMain(
    `let mut n = 0; let mut m = 0; let r = &mut n;
    let mut q = &mut m; q = r; *q += 1;
    let saved = Holder { r }; *saved.r += 1;
    let tuple: (&mut i32,) = (r,); *tuple.0 += 1;
    *r += 1; println!("{}", n);`,
    "struct Holder<'a> { r: &'a mut i32 }"
  );
  expect(executeProgram('rust', source)).toMatchObject({ kind: 'executed', stdout: '4\n' });
  for (const value of ['{ r }', 'identity(r)']) {
    const moved = rustMain(
      `let mut n = 0; let r = &mut n; let q = ${value}; *q += 1; *r += 1;`,
      'fn identity<T>(x: T) -> T { x }'
    );
    expect(executeProgram('rust', moved)).toMatchObject({ kind: 'compileError' });
  }
  const overlapping = rustMain('let mut n = 0; let r = &mut n; let q: &mut i32 = { r }; *r += 1; *q += 1;');
  expect(executeProgram('rust', overlapping)).toMatchObject({ kind: 'compileError' });
});

test('allows Rust mutable cursors to advance through a matched reference in a loop', () => {
  for (const walk of [
    'while let Some(next) = &mut cursor.next { cursor = next; }',
    'loop { match &mut cursor.next { Some(next) => cursor = next, None => break } }',
  ]) {
    const source = rustMain(
      `let mut head = Node { value: 1, next: Some(Box::new(Node { value: 2, next: None })) };
      let mut cursor = &mut head;
      ${walk}
      cursor.value += 10;
      println!("{}", head.next.unwrap().value);`,
      'struct Node { value: i32, next: Option<Box<Node>> }'
    );
    expect(executeProgram('rust', source)).toMatchObject({ kind: 'executed', stdout: '12\n' });
  }
});

test('supports Rust short-circuit iterator folds and generation', () => {
  const source = rustMain(
    `let mut it = 1..6;
    let result: Result<i32, &str> = it.try_fold(0, |sum, n| {
      if n == 3 { Err("stop") } else { Ok(sum + n) }
    });
    println!("{:?} {:?}", result, it.next());
    let option = (1..4).try_fold(0_i32, |sum, n| sum.checked_add(n));
    let flow = (0..5).try_fold(0, |sum, n| {
      if n == 2 { ControlFlow::Break(sum) } else { ControlFlow::Continue(sum + n) }
    });
    let mut n = 3;
    let ids: Vec<_> = std::iter::repeat_with(|| { n += 1; n }).take(3).collect();
    println!("{:?} {:?} {:?} {}", option, flow, ids, n);`,
    'use std::ops::ControlFlow;'
  );
  expect(executeProgram('rust', source)).toMatchObject({
    kind: 'executed',
    stdout: 'Err("stop") Some(4)\nSome(6) Break(1) [4, 5, 6] 6\n',
  });
});

test('supports Rust iterator ordering, partition searching, and comparator maxima', () => {
  const source = rustMain(`let numbers = [1, 3, 5, 7];
    let bound = numbers.partition_point(|n| *n < 5);
    let best = std::cmp::max_by("bbb", "aa", |a, b| a.len().cmp(&b.len()));
    println!("{} {} {} {} {} {:?} {:?}", bound, best, (0..3).lt(1..3),
      [0, 1].into_iter().le([0, 1]), (1..3).ge(0..3),
      (1..3).cmp(0..3), [f64::NAN].into_iter().partial_cmp([1.0_f64]));`);
  expect(executeProgram('rust', source)).toMatchObject({
    kind: 'executed',
    stdout: '2 bbb true true true Greater None\n',
  });
});

test('supports Rust slice splitting and deque subranges', () => {
  const source = rustMain(
    `let values = [0, 1, 0, 2, 0];
    let mut pieces = values.split(|n| *n == 0);
    println!("{:?} {:?} {:?}", pieces.next(), pieces.next_back(), pieces);
    println!("{:?}", pieces.clone().collect::<Vec<_>>());
    let deque = VecDeque::from([10, 20, 30, 40, 50]);
    println!("{:?}", deque.range(1..=3).rev().collect::<Vec<_>>());`,
    'use std::collections::VecDeque;'
  );
  expect(executeProgram('rust', source)).toMatchObject({
    kind: 'executed',
    stdout: 'Some([]) Some([]) Split { v: [1, 0, 2], finished: false }\n[[1], [2]]\n[40, 30, 20]\n',
  });
});

test('supports Rust float bit conversions, UTF-8 validation, and character escaping', () => {
  const source = rustMain(String.raw`let float = f64::from_bits(0x3ff8000000000000);
    let single = f32::from_bits(0x80000000);
    println!("{} {} {:?} {:?}", float, float.to_bits(), single, 0.0_f64.sin_cos());
    println!("{:?} {:?}", std::str::from_utf8(&[104, 105]), std::str::from_utf8(&[0xff]));
    let mut escaped = 'é'.escape_default();
    println!("{} {:?} {}", escaped, escaped.clone(), escaped.len());
    escaped.next();
    println!("{} {:?}", escaped, escaped);`);
  expect(executeProgram('rust', source)).toMatchObject({
    kind: 'executed',
    stdout: String.raw`1.5 4609434218613702656 -0.0 (0.0, 1.0)
Ok("hi") Err(Utf8Error { valid_up_to: 0, error_len: Some(1) })
\u{e9} EscapeDefault(EscapeIterInner('\u{e9}')) 6
u{e9} EscapeDefault(EscapeIterInner('u{e9}'))
`,
  });
});

test('replaces Rust HashSet entries and returns ownership of the previous value', () => {
  const source = rustMain(
    `let mut set = HashSet::new();
    println!("{:?} {:?} {}", set.replace(String::from("same")), set.replace(String::from("same")), set.len());`,
    'use std::collections::HashSet;'
  );
  expect(executeProgram('rust', source)).toMatchObject({ kind: 'executed', stdout: 'None Some("same") 1\n' });
});

test('keeps assertion operands alive during construction and equality', () => {
  const program = `struct Holder(Turtle, bool);
impl PartialEq for Holder {
    fn eq(&self, right: &Self) -> bool {
        let observer = Turtle::new(1, 1, "G");
        println!("{}", observer.can_move_forward());
        right.1
    }
}
impl std::fmt::Debug for Holder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "Holder") }
}
fn rhs(o: &Turtle, equal: bool) -> Holder {
    println!("{}", o.can_move_forward());
    Holder(Turtle::new(4, 4, "B"), equal)
}
fn main() {
    let observer = Turtle::new(1, 1, "G");
    assert_eq!(Holder(Turtle::new(1, 2, "R"), true), rhs(&observer, true));
    assert_ne!(Holder(Turtle::new(1, 2, "R"), true), rhs(&observer, false));
    println!("{}", observer.can_move_forward());
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: 'false\nfalse\nfalse\nfalse\ntrue\n',
    uncaughtException: undefined,
  });
});

test('sizes Rust 2024 closures by their captured fields and capture modes', () => {
  const program = `struct S { a: u8, b: u64 }
struct Wrapped<T> { inner: (T, u64), unused: u64 }
fn size<T>(_: T) -> usize { std::mem::size_of::<T>() }
fn generic<T>(value: T) -> usize {
    let x = Wrapped { inner: (value, 0), unused: 0 };
    size(move || x.inner.0)
}
fn main() {
    let s = S { a: 1, b: 2 };
    let pair = (1u8, 2u64);
    let copy = move || s.a;
    let both = || s.a as u64 + s.b;
    let boxed = Box::new(S { a: 1, b: 2 });
    println!("{} {} {} {} {}", size(copy), size(move || pair.0), size(both),
        size(move || boxed.a), generic(1u16));
}`;
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: '1 1 16 8 2\n' });
});

test('iterates the hidden type of a trait method called with a generic receiver', () => {
  const program = `trait Make {
    fn range(&self) -> impl Iterator<Item=u32>;
    fn vec(&self) -> impl IntoIterator<Item=i32>;
}
struct Source;
impl Make for Source {
    fn range(&self) -> impl Iterator<Item=u32> { 0..3 }
    fn vec(&self) -> impl IntoIterator<Item=i32> { vec![1, 2, 3] }
}
fn run<T: Make>(source: &T) {
    println!("{}", source.range().sum::<u32>());
    println!("{:?}", source.range().map(|x| x + 1).collect::<Vec<_>>());
    for x in source.range() { print!("{}", x); }
    println!();
    for x in source.vec() { print!("{}", x); }
    println!();
}
fn main() { run(&Source); }`;
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: '3\n[1, 2, 3]\n012\n123\n' });
});

test('copies the adjusted by-value receiver of a method on a Box', () => {
  const program = `#[derive(Copy, Clone)] struct S { x: i32 }
impl S { fn changed(mut self) -> i32 { self.x = 9; self.x } }
struct Holder { boxed: Box<S> }
fn main() {
    let s = Box::new(S { x: 1 });
    let h = Holder { boxed: Box::new(S { x: 2 }) };
    let f = || s.changed();
    println!("{} {} {} {} {}", f(), f(), s.x, h.boxed.changed(), h.boxed.x);
}`;
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: '9 9 1 9 2\n' });
});

test('follows indexed constant initializers while checking function bodies', () => {
  const program = `const A: [i32; 2] = [1, 2];
const B: [i32; 2] = [A[1], 3];
const C: [i32; 3] = [A[0]; 3];
const D: i32 = A[1] + 1;
fn main() { println!("{:?} {:?} {}", B, C, D); }`;
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: '[2, 3] [1, 1, 1] 3\n' });
  expect(executeProgram('rust', program.replace('A[1], 3', 'A[2], 3'))).toMatchObject({ kind: 'compileError' });
});

test('preserves untouched fields in constant arrays written through an unknown index', () => {
  const program = `struct S { x: i32, a: Option<String> }
const N: S = S { x: 1, a: None };
const P: (Option<String>, i32) = (None, 1);
const X: i32 = {
    let mut a = [N; 2];
    let mut b = [P, P];
    let i = 1_usize.wrapping_sub(1);
    a[i].x = 2;
    b[i].1 = 3;
    a[0].x + b[0].1
};
fn main() { println!("{}", X); }`;
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: '5\n' });
});

test('applies clone_from through standard containers according to their storage rules', () => {
  const program = `use std::collections::{BinaryHeap, VecDeque};
fn main() {
    let mut a = [[String::with_capacity(12)]];
    a.clone_from_slice(&[[String::from("abc")]]);
    let mut b = [Box::new(Vec::with_capacity(12))];
    b.clone_from_slice(&[Box::new(vec![1, 2])]);
    let mut o = Some(String::with_capacity(12));
    o.clone_from(&Some(String::from("abc")));
    let mut r: Result<String, ()> = Ok(String::with_capacity(12));
    r.clone_from(&Ok(String::from("abc")));
    let mut d = VecDeque::with_capacity(12);
    d.push_front(String::with_capacity(12));
    d.clone_from(&VecDeque::from([String::from("abc")]));
    let mut h = BinaryHeap::with_capacity(12);
    h.push(String::with_capacity(12));
    h.clone_from(&BinaryHeap::from([String::from("abc")]));
    println!("{} {} {} {} {} {} {} {}", a[0][0].capacity(), b[0].capacity(),
        o.unwrap().capacity(), r.unwrap().capacity(), d.capacity(), d[0].capacity(),
        h.capacity(), h.peek().unwrap().capacity());
}`;
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: '12 12 12 12 12 3 12 12\n' });
});

test('checks typed constant array lengths before and after scalar casts', () => {
  const program = `const YES: bool = 1 < 2;
fn main() {
    let a: [i32; (1 < 2) as usize] = [7];
    let b: [i32; YES as usize] = [7];
    let c: [i32; (true && false) as usize] = [];
    let d: [i32; (true || false) as usize] = [7];
    let e: [i32; f32::NAN as usize] = [];
    let f: [i32; f64::NAN as usize] = [];
    let g: [i32; f32::NEG_INFINITY as usize] = [];
    let h: [i32; f32::MAX as u8 as usize] = [0; 255];
    let i: [i32; (true || (1 / 0 == 2)) as usize] = [7];
    let j: [i32; ((-128i8 as u8) - (1 + 2u8)) as usize] = [0; 125];
    println!("{} {} {} {} {} {} {} {} {} {}", a.len(), b.len(), c.len(), d.len(),
        e.len(), f.len(), g.len(), h.len(), i.len(), j.len());
}`;
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: '1 1 0 1 0 0 0 255 1 125\n' });
  for (const [length, count] of [
    ['(255u8 + 1) as usize', 256],
    ['256u8 as usize', 256],
    ['(1u8 + 1u16) as usize', 2],
    ['(1u8 << 8) as usize', 0],
    ['1u8', 1],
  ] as const) {
    const invalid = rustMain(`let _: [i32; ${length}] = [0; ${count}];`);
    expect(executeProgram('rust', invalid)).toMatchObject({ kind: 'compileError' });
  }
});

test('reborrows explicitly constrained generic reference arguments', () => {
  const program = `fn id<T>(value: T) -> T { value }
fn use_it<T>(_: T) {}
fn main() {
    let mut n = 0;
    let r = &mut n;
    let q: Option<&mut i32> = Some(r);
    *q.unwrap() += 1;
    let x: &mut i32 = id(r);
    *x += 1;
    use_it::<&mut i32>(r);
    *r += 1;
    println!("{}", n);
}`;
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: '3\n' });
  const inferred = program.replace('q: Option<&mut i32> = Some(r)', 'q = Some(r)');
  expect(executeProgram('rust', inferred)).toMatchObject({ kind: 'compileError' });
});

test('binds written generics while inferring associated items and argument impl Traits', () => {
  const program = `trait M {
    fn first<I: Iterator>(&self, mut i: I) -> Option<I::Item> { i.next() }
    fn second<T>(&self, mut i: impl Iterator<Item=T>) -> Option<T> { i.nth(1) }
}
struct S;
impl M for S {}
fn first<I: Iterator>(mut iter: I) -> Option<I::Item> { iter.next() }
fn main() {
    let f = M::first::<std::ops::Range<i32>>;
    println!("{:?} {:?} {:?} {:?} {:?}",
        f(&S, 1..3), M::second::<i32>(&S, 1..3), S::second::<i32>(&S, 1..3),
        S.first::<std::ops::Range<i32>>(1..3), first::<std::ops::Range<i32>>(1..3));
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: 'Some(1) Some(2) Some(2) Some(1) Some(1)\n',
  });
});

test('brings method-local where bounds into generic impl and trait bodies', () => {
  const program = `use std::fmt::Debug;
struct Pair<T> { x: T, y: T }
impl<T> Pair<T> {
    fn largest(&self) -> &T where T: PartialOrd {
        if self.x >= self.y { &self.x } else { &self.y }
    }
    fn show(&self) -> String where T: Debug { format!("{:?}", self.x) }
}
trait DisplaySelf {
    fn show(&self) -> String where Self: Debug { format!("{:?}", self) }
}
#[derive(Debug)]
struct A;
impl DisplaySelf for A {}
fn main() {
    let p = Pair { x: 3, y: 8 };
    println!("{} {} {}", p.largest(), p.show(), A.show());
}`;
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: '8 3 A\n' });
});

test('proves iterator capabilities through nested generic adapters', () => {
  const program = `fn f<I: DoubleEndedIterator<Item=i32> + ExactSizeIterator>(i: I) -> Vec<i32> {
    i.enumerate().take(2).rev().map(|(n, v)| n as i32 + v).rev().collect()
}
fn main() { println!("{:?}", f(3..7)); }`;
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: '[3, 5]\n' });
  const missing = program.replace(' + ExactSizeIterator', '');
  expect(executeProgram('rust', missing)).toMatchObject({ kind: 'compileError' });
});

test('prints the residual slice of Windows clones across both ends', () => {
  const program = rustMain(`let v = [1, 2, 3];
    let mut short = v.windows(4);
    let mut back = short.clone();
    println!("{:?} {:?}", short.next(), short);
    println!("{:?} {:?}", back.next_back(), back);
    let mut a = v.windows(2);
    let mut b = a.clone();
    println!("{:?} {:?} {:?}", a.next(), a.next_back(), a);
    println!("{:?} {:?}", a.next_back(), a);
    println!("{:?} {:?}", b.nth(8), b);`);
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout:
      'None Windows { v: [1, 2, 3], size: 4 }\nNone Windows { v: [], size: 4 }\n' +
      'Some([1, 2]) Some([2, 3]) Windows { v: [2], size: 2 }\n' +
      'None Windows { v: [], size: 2 }\nNone Windows { v: [], size: 2 }\n',
  });
});

test('checks explicit and implicit enum discriminants against isize', () => {
  const body = 'println!("{} {}", E::A as i64, E::B as i64);';
  const valid = rustMain(body, 'enum E { A = 9223372036854775806, B }');
  expect(executeProgram('rust', valid)).toMatchObject({
    kind: 'executed',
    stdout: '9223372036854775806 9223372036854775807\n',
  });
  const invalid = rustMain(body, 'enum E { A = 9223372036854775807, B }');
  expect(executeProgram('rust', invalid)).toMatchObject({ kind: 'compileError' });
  const tooWide = rustMain('println!("{}", E::A as i64);', 'enum E { A = 9223372036854775808 }');
  expect(executeProgram('rust', tooWide)).toMatchObject({ kind: 'compileError' });
});

test('checks loop bodies with facts valid after the back edge', () => {
  const loops = [
    'while x > 0 { x = x * 2; }',
    'for _ in 0..3 { x += 100; }',
    'for _ in [1, 2] { x += 100; }',
    'loop { x += 100; if x > 0 { break; } }',
  ];
  for (const loop of loops) {
    const overflow = rustMain(`println!("start"); let mut x: i8 = 100; ${loop}`);
    expect(executeProgram('rust', overflow)).toMatchObject({
      kind: 'executed',
      stdout: 'start\n',
      uncaughtException: expect.stringContaining('overflow'),
    });
  }
  const bounds = rustMain(`let mut n = 250u8;
    while n < 10 { n += 1; let z = [1, 2, 3]; let _w = z[5]; }`);
  expect(executeProgram('rust', bounds)).toMatchObject({ kind: 'compileError' });
});

test('rebuilds a partially extended BinaryHeap on iterator panic', () => {
  const program = `use std::cmp::Ordering;
use std::collections::BinaryHeap;
#[derive(Debug, Eq, PartialEq)]
struct K(i32);
impl Ord for K {
    fn cmp(&self, b: &Self) -> Ordering {
        print!("cmp {} {};", self.0, b.0);
        self.0.cmp(&b.0)
    }
}
impl PartialOrd for K {
    fn partial_cmp(&self, b: &Self) -> Option<Ordering> { Some(self.cmp(b)) }
}
fn main() {
    let mut h = BinaryHeap::from([K(1)]);
    h.extend((0..3).map(|n| {
        if n == 1 { panic!("stop"); }
        K(n + 2)
    }));
}`;
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: 'cmp 2 1;' });
});

test('collects dropped turtles on panic and process exit', () => {
  for (const [ending, y] of [
    ['a.turnRight(); a.turnRight(); a.forward();', -1],
    ['std::process::exit(0);', 0],
  ] as const) {
    const program = rustMain(
      `let b = Turtle::new(5, 5);
      consume(b);
      let mut a = Turtle::new(0, 0);
      ${ending}`,
      'fn consume(mut t: Turtle) { t.forward(); }'
    );
    const expected = { finalTurtles: [{ x: 0, y }] };
    expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', ...expected });
    expect(traceProgram('rust', program, program)).toMatchObject(expected);
  }
});

test('checks multiple impl Trait bounds and explicit dyn object lifetimes', () => {
  const program = `use std::fmt::{Debug, Display};
fn show(x: &(impl Display + Debug)) -> String { format!("{} {:?}", x, x) }
fn make() -> impl Display + Clone { 5 }
fn items<'a>(x: &'a [i32]) -> impl Iterator<Item = &'a i32> + 'a { x.iter() }
fn boxed<'a>(x: &'a i32) -> Box<dyn Display + 'a> { Box::new(x) }
fn prefix<'a>(x: &'a i32) -> Box<dyn 'a + Display> { boxed(x) }
fn main() {
    let n = 7;
    let values = [8, 9];
    println!("{} {} {:?} {} {}", show(&"a"), make().clone(),
        items(&values).collect::<Vec<_>>(), boxed(&n), prefix(&n));
    let singleton: (i32,) = (1,);
    println!("{}", singleton.0);
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: 'a "a" 5 [8, 9] 7 7\n1\n',
  });
  const missing = program.replace('impl Display + Clone', 'impl Display');
  expect(executeProgram('rust', missing)).toMatchObject({ kind: 'compileError' });
  const ambiguous = program.replace('&(impl Display + Debug)', '&impl Display + Debug');
  expect(executeProgram('rust', ambiguous)).toMatchObject({ kind: 'compileError' });
});

test('uses the mode of each captured projection to lay out a closure', () => {
  const program = `struct S { a: String, b: [u8; 64] }
struct Texts { a: String, b: String }
fn size<T>(_: T) -> usize { std::mem::size_of::<T>() }
fn main() {
    let s = S { a: String::new(), b: [0; 64] };
    let t = Texts { a: String::from("a"), b: String::from("b") };
    let f = || { drop(s.a); println!("{}", s.b[0]); };
    let g = || { drop(t.a); println!("{}", t.b); };
    println!("{} {}", size(f), size(g));
}`;
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: '32 32\n' });
});

test('uses the outer reference contract even when its referent is inferred', () => {
  const program = `fn id<T>(x: T) -> T { x }
fn main() {
    let mut v = vec![1];
    let r = &mut v;
    let a: &mut _ = id(r);
    a.push(2);
    let b: &mut Vec<_> = id(r);
    b.push(3);
    let c: Option<&mut Vec<_>> = Some(r);
    c.unwrap().push(4);
    r.push(5);
    println!("{:?}", v);
}`;
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: '[1, 2, 3, 4, 5]\n' });
});

test('skips unreachable while bodies when the condition stays known after the back edge', () => {
  const source = rustMain(`while false { let a = [1, 2]; let _x = a[3]; }
    let n = 0;
    while n > 5 { let a = [1, 2]; let _x = a[3]; }
    println!("kept");`);
  expect(executeProgram('rust', source)).toMatchObject({ kind: 'executed', stdout: 'kept\n' });
});

test('uses the declared precision of mathematical constants in array lengths', () => {
  const program = `use std::f64::consts::PI;
fn main() {
    let a: [i32; std::f64::consts::PI as usize] = [0; 3];
    let b: [i32; std::f32::consts::E as usize] = [0; 2];
    let c: [i32; PI as usize] = [0; 3];
    println!("{} {} {}", a.len(), b.len(), c.len());
}`;
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: '3 2 3\n' });
});

test('takes constant array and UTF-8 string lengths at each array declaration site', () => {
  const program = `const NAMES: [&str; 3] = ["a", "b", "c"];
const N: usize = NAMES.len();
const SLICE: &[i32] = &[7, 8, 9, 10];
const TEXT: &str = "élan";
fn main() {
    let counts = [0; N];
    let typed: [i32; NAMES.len()] = [0; 3];
    let slice: [i32; SLICE.len()] = [0; 4];
    let text: [i32; TEXT.len()] = [0; 5];
    let literal: [i32; [1, 2].len()] = [0; 2];
    println!("{:?} {} {} {} {}", counts, typed.len(), slice.len(), text.len(), literal.len());
}`;
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: '[0, 0, 0] 3 4 5 2\n' });
  const mixed = rustMain('let _: [i32; [1, false].len()] = [0; 2];');
  expect(executeProgram('rust', mixed)).toMatchObject({ kind: 'compileError' });
});

test('requires sized by-value inputs, returns and bindings while allowing borrowed trait objects', () => {
  const program = `trait Shape {}
struct Square;
impl Shape for Square {}
fn draw(s: &dyn Shape) {
    let borrowed: &dyn Shape = s;
    let _: dyn Shape = *borrowed;
    println!("draw");
}
fn main() { draw(&Square); }`;
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: 'draw\n' });
  for (const body of ['let _x: dyn Shape = unimplemented!();', 'let s: &dyn Shape = &Square; let _x = *s;']) {
    expect(
      executeProgram('rust', rustMain(body, 'trait Shape {} struct Square; impl Shape for Square {}'))
    ).toMatchObject({ kind: 'compileError' });
  }
  for (const declaration of [
    'fn area(_s: dyn Shape) -> i32 { 1 }',
    'fn area(_s: (i32, dyn Shape)) -> i32 { 1 }',
    'fn area() -> dyn Shape { unimplemented!() }',
  ]) {
    expect(executeProgram('rust', rustMain('', `trait Shape {} ${declaration}`))).toMatchObject({
      kind: 'compileError',
    });
  }
});

test('defaults boxed strings and slices to empty values without an element bound', () => {
  const program = `struct NoDefault;
fn main() {
    let a: Box<str> = Default::default();
    let b: Box<[i64]> = Box::default();
    let c: Box<[NoDefault]> = Default::default();
    let d: Box<i32> = Box::default();
    println!("{} {} {} {}", a.is_empty(), b.len(), c.len(), *d);
}`;
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: 'true 0 0 0\n' });
});

test('checks typed repeated allocations before converting the count to a number', () => {
  for (const [body, location] of [
    ['let _ = vec![0u8; 9223372036854775808usize];', 'alloc/src/raw_vec/mod.rs:28:5'],
    ['let _ = vec![0u64; usize::MAX / 4];', 'alloc/src/raw_vec/mod.rs:28:5'],
    ['let mut v = vec![0u8]; v.resize(usize::MAX, 0);', 'alloc/src/raw_vec/mod.rs:28:5'],
    ['let _ = [0u8, 1].repeat(usize::MAX);', 'alloc/src/slice.rs:524:50'],
    ['let _ = "ab".repeat(usize::MAX);', 'alloc/src/slice.rs:524:50'],
  ] as const) {
    const run = executeProgram('rust', rustMain(body));
    expect(run).toMatchObject({
      kind: 'executed',
      uncaughtException: expect.stringContaining(`${location}:\ncapacity overflow`),
    });
  }
  const tooLarge = executeProgram('rust', rustMain('let _ = vec![0u8; 1usize << 50];'));
  expect(tooLarge).toMatchObject({
    kind: 'executed',
    uncaughtException: expect.stringContaining('memory allocation of 1125899906842624 bytes failed'),
  });
});

test('captures array storage before slice coercion and projects destructured closure captures', () => {
  const program = `struct S { a: String, b: [u8; 64] }
struct Nested { x: S, y: u64 }
fn size<T>(_: T) -> usize { std::mem::size_of::<T>() }
fn main() {
    let s = S { a: String::new(), b: [0; 64] };
    let mixed = || { drop(s.a); println!("{} {} {}", s.b.len(), s.b.iter().count(), s.b.is_empty()); };
    let nested = Nested { x: S { a: String::new(), b: [1; 64] }, y: 7 };
    let named = || { let Nested { x: S { a, b: _ }, y: _ } = nested; drop(a); };
    let pair = (String::new(), [2u8; 64]);
    let tuple = || { let (a, _) = pair; drop(a); };
    println!("{} {} {}", size(mixed), size(named), size(tuple));
    println!("{} {} {}", nested.x.b[0], nested.y, pair.1[0]);
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: '32 24 24\n1 7 2\n',
  });
});

test('uses Rust relation methods for Ord extrema and forwards free extrema to Ord overrides', () => {
  const program = `use std::cmp::{self, Ordering};
#[derive(Eq, PartialEq)]
struct Job(i32);
impl PartialOrd for Job {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        print!("p{}:{} ", self.0, other.0);
        Some(self.0.cmp(&other.0))
    }
}
impl Ord for Job {
    fn cmp(&self, other: &Self) -> Ordering {
        print!("c{}:{} ", self.0, other.0);
        other.0.cmp(&self.0)
    }
}
#[derive(Eq, PartialEq, PartialOrd)]
struct Override(i32);
impl Ord for Override {
    fn cmp(&self, other: &Self) -> Ordering { self.0.cmp(&other.0) }
    fn max(self, other: Self) -> Self { Self(self.0 + other.0) }
}
fn main() {
    println!("{} {}", Job(1).max(Job(5)).0, Job(1).min(Job(5)).0);
    println!("{} {}", cmp::max(Job(1), Job(5)).0, cmp::min(Job(1), Job(5)).0);
    println!("{}", Job(5).clamp(Job(1), Job(3)).0);
    println!("{}", cmp::max(Override(2), Override(4)).0);
    println!("{}", [Job(1), Job(5)].into_iter().max().unwrap().0);
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: 'p5:1 p5:1 5 1\np5:1 p5:1 5 1\np1:3 p5:1 p5:3 3\n6\nc1:5 1\n',
  });
});

test('reports exact written range bounds before converting them into byte or slice offsets', () => {
  for (const [body, message] of [
    [
      'let s = String::from("abc"); let _ = &s[..=s.len()];',
      'end byte index 3 is out of bounds for string of length 3',
    ],
    [
      'let s = String::from("abc"); let _ = &s[1..=usize::MAX];',
      'end byte index 18446744073709551615 is out of bounds for string of length 3',
    ],
    ['let s = String::from("abc"); let _ = &s[6..=5];', 'start byte index 6 is out of bounds for string of length 3'],
    [
      'let s = String::from("éx"); let _ = &s[..=0];',
      "end byte index 1 is not a char boundary; it is inside 'é' (bytes 0..2 of string)",
    ],
    [
      'let v = vec![1, 2, 3]; let _ = &v[1..=usize::MAX];',
      'range end index 18446744073709551615 out of range for slice of length 3',
    ],
  ] as const) {
    expect(executeProgram('rust', rustMain(body))).toMatchObject({
      kind: 'executed',
      uncaughtException: expect.stringContaining(message),
    });
  }
});

test('uses the individual Rust relation operators for heap sifts and reverses operands for Reverse', () => {
  const program = `use std::cmp::{Ordering, Reverse};
use std::collections::BinaryHeap;
#[derive(Clone, Copy, Eq, PartialEq)]
struct K(i32);
impl PartialOrd for K {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> { Some(self.0.cmp(&other.0)) }
    fn lt(&self, other: &Self) -> bool { print!("lt{}:{} ", self.0, other.0); self.0 < other.0 }
    fn le(&self, other: &Self) -> bool { print!("le{}:{} ", self.0, other.0); self.0 <= other.0 }
    fn ge(&self, other: &Self) -> bool { print!("ge{}:{} ", self.0, other.0); self.0 >= other.0 }
}
impl Ord for K {
    fn cmp(&self, other: &Self) -> Ordering {
        print!("cmp{}:{} ", self.0, other.0);
        other.0.cmp(&self.0)
    }
}
fn main() {
    let mut h = BinaryHeap::from([K(3), K(1), K(2)]);
    println!("{}", h.peek().unwrap().0);
    h.push(K(5));
    println!("{}", h.pop().unwrap().0);
    println!("{:?}", h.into_sorted_vec().into_iter().map(|k| k.0).collect::<Vec<_>>());
    println!("{}", Reverse(K(1)) < Reverse(K(2)));
    println!("{:?}", Reverse(K(1)).cmp(&Reverse(K(2))));
    let mut keys = [K(3), K(1), K(2)];
    keys.sort_by_key(|k| Reverse(*k));
    println!("{:?}", keys.map(|k| k.0));
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout:
      'le1:2 ge3:2 3\nle5:1 le5:3 le3:2 le1:3 5\nlt2:1 [1, 2, 3]\nlt2:1 false\ncmp2:1 Less\nlt3:1 lt1:2 lt3:2 [3, 2, 1]\n',
  });
});

test('lints only reachable let-condition and let-else bodies', () => {
  const program = `fn main() {
    let optional: Option<i32> = None;
    while let Some(_) = optional { let a = [1, 2]; let _x = a[3]; }
    while let Some(_) = None::<i32> { let a = [1, 2]; let _x = a[3]; }
    let n = 3;
    while let 4 = n { let a = [1, 2]; let _x = a[3]; }
    if let Some(_) = optional { let a = [1, 2]; let _x = a[3]; }
    let Some(_) = Some(3) else { let a = [1, 2]; let _x = a[3]; return; };
    println!("alive");
}`;
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: 'alive\n' });
  const reached = program.replace('while let 4 = n', 'while let 3 = n');
  expect(executeProgram('rust', reached)).toMatchObject({ kind: 'compileError' });
});

test('dispatches PartialEq inequality independently of equality', () => {
  const program = `struct Item(i32);
impl PartialEq for Item {
    fn eq(&self, other: &Self) -> bool { print!("eq "); self.0 == other.0 }
    fn ne(&self, other: &Self) -> bool { print!("ne "); self.0 != other.0 }
}
struct DefaultNe(i32);
impl PartialEq for DefaultNe {
    fn eq(&self, other: &Self) -> bool { print!("default "); self.0 == other.0 }
}
fn different<T: PartialEq>(a: T, b: T) -> bool { a != b }
fn main() {
    println!("{}", Item(1) != Item(2));
    println!("{}", different(Item(1), Item(1)));
    println!("{}", Item(1) == Item(2));
    println!("{}", DefaultNe(1) != DefaultNe(2));
    println!("{}", Box::new(Item(1)) != Box::new(Item(2)));
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: 'ne true\nne false\neq false\ndefault true\nne true\n',
  });
});

test('limits a temporary method receiver borrow to its statement or block tail', () => {
  const working = rustMain(`println!("{}", String::from("hello").as_str());
    println!("{:?}", vec![1, 2].as_slice());
    let owner = String::from("live");
    let borrowed = owner.as_str();
    println!("{}", borrowed);
    let extended = &String::from("extended");
    println!("{}", extended);`);
  expect(executeProgram('rust', working)).toMatchObject({
    kind: 'executed',
    stdout: 'hello\n[1, 2]\nlive\nextended\n',
  });
  for (const body of [
    'let r = String::from("hello").as_str(); println!("{}", r);',
    'let r = vec![1, 2, 3].as_slice(); println!("{:?}", r);',
    'println!("{}", { String::from("hello").as_str() });',
    'let r = || String::from("hello").as_str(); println!("{}", r());',
  ]) {
    expect(executeProgram('rust', rustMain(body))).toMatchObject({ kind: 'compileError' });
  }
});

test('rejects unsized fields in enums and before the final field of a struct', () => {
  for (const item of [
    'enum E { V(dyn Shape) }',
    'enum E { V { field: dyn Shape } }',
    'enum E { V(str) }',
    'enum E { V([dyn Shape; 2]) }',
    'struct S { first: dyn Shape, last: i32 }',
    'struct S { array: [dyn Shape; 2] }',
  ]) {
    expect(executeProgram('rust', rustMain('', `trait Shape {} ${item}`))).toMatchObject({ kind: 'compileError' });
  }
  expect(executeProgram('rust', rustMain('', 'trait Shape {} struct S { tail: dyn Shape }'))).toMatchObject({
    kind: 'executed',
  });
});

test('requires irrefutable patterns in explicit and inferred closure parameters', () => {
  for (const body of [
    'let f = |Some(x): Option<i32>| x; println!("{}", f(Some(3)));',
    'let f = |true: bool| 1; println!("{}", f(false));',
    'let f = |Some(x)| x; println!("{}", f(Some(3)));',
  ]) {
    expect(executeProgram('rust', rustMain(body))).toMatchObject({ kind: 'compileError' });
  }
  expect(executeProgram('rust', rustMain('let f = |(a, b)| a + b; println!("{}", f((1, 2)));'))).toMatchObject({
    kind: 'executed',
    stdout: '3\n',
  });
});

test('takes closure parameter types from callable object and field bounds', () => {
  const program = `use std::collections::HashMap;
struct Cacher<T: Fn(u32) -> u32> { calculation: T }
struct Named<F> where F: Fn(&str) -> usize { f: F }
struct Boxed { f: Box<dyn Fn(&str) -> usize> }
fn main() {
    let c = Cacher { calculation: |n| n.pow(2) };
    let named = Named { f: |s| s.len() };
    let boxed = Boxed { f: Box::new(|s| s.len()) };
    let f: &dyn Fn(&Vec<i32>) -> usize = &|values| values.len();
    let add: Box<dyn Fn((i32, i32)) -> i32> = Box::new(|p| p.0 + p.1);
    let mut callbacks: HashMap<&str, Box<dyn Fn(&[i32]) -> i32>> = HashMap::new();
    callbacks.insert("sum", Box::new(|values| values.iter().sum()));
    println!("{} {} {} {} {} {}", (c.calculation)(3), (named.f)("ab"), (boxed.f)("abc"),
        f(&vec![1]), add((1, 2)), callbacks["sum"](&[2, 3]));
}`;
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: '9 2 3 1 3 5\n' });
});

test('retains static callback bounds through generic parameters and trait objects', () => {
  const program = `fn named<F: Fn(i32) -> i32 + 'static>(f: F) -> Box<dyn Fn(i32) -> i32> { Box::new(f) }
fn after<F>(f: F) -> Box<dyn Fn(i32) -> i32> where F: Fn(i32) -> i32 + 'static { Box::new(f) }
fn anonymous(f: impl Fn(i32) -> i32 + 'static) -> Box<dyn Fn(i32) -> i32> { Box::new(f) }
fn main() {
    let n = 2;
    let f = named(move |x| x + n);
    let g = after(|x| x * 2);
    let h = anonymous(|x| x - 1);
    println!("{} {} {}", f(3), g(3), h(3));
}`;
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: '5 6 2\n' });
  expect(executeProgram('rust', program.replace('named(move |x|', 'named(|x|'))).toMatchObject({
    kind: 'compileError',
  });
  expect(executeProgram('rust', program.replace(" + 'static>(f:", '>(f:'))).toMatchObject({ kind: 'compileError' });
});

test('sizes arrays from constant aggregates regardless of scalar or aggregate element shape', () => {
  const program = rustMain(`let a: [i32; [[1, 2], [3, 4]].len()] = [0; 2];
    let b = [0; [Some(1), None].len()];
    let c: [i32; [Some(1), None].len()] = [0; 2];
    println!("{} {} {}", a.len(), b.len(), c.len());`);
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: '2 2 2\n' });
  const invalid = rustMain('let _: [i32; [Some(1), Some(false)].len()] = [0; 2];');
  expect(executeProgram('rust', invalid)).toMatchObject({ kind: 'compileError' });
});

test('keeps prior dbg operands live across later evaluation and formatting', () => {
  const program = `use std::fmt;
struct Holder { t: Turtle }
impl fmt::Debug for Holder {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        let observer = Turtle::new(0, 0);
        println!("{}", observer.can_move_forward());
        write!(f, "Holder")
    }
}
fn main() {
    let a = Holder { t: Turtle::new(0, 1) };
    let b = Turtle::new(0, 0);
    let pair = dbg!(a, b.can_move_forward());
    println!("{}", pair.1);
    let mut a = pair.0;
    a.t.forward();
}`;
  const expected = {
    stdout: 'false\nfalse\n',
    finalTurtles: [
      { x: 0, y: 2 },
      { x: 0, y: 0 },
    ],
  };
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', ...expected });
  expect(traceProgram('rust', program, program)).toMatchObject(expected);
});

test('rejects unresolved unary minus operands before code generation', () => {
  for (const arg of ['true', '1u32', '1i32']) {
    expect(executeProgram('rust', rustMain(`let neg = |x| -x; println!("{}", neg(${arg}));`))).toMatchObject({
      kind: 'compileError',
    });
  }
  expect(executeProgram('rust', rustMain('let neg = |x: i32| -x; println!("{} {}", neg(1), -2);'))).toMatchObject({
    kind: 'executed',
    stdout: '-1 -2\n',
  });
});

test('formats UTF-8 errors and their fields using pretty Debug', () => {
  const program = rustMain(`println!("{:#?}", std::str::from_utf8(&[255u8]));
    println!("{:#?}", String::from_utf8(vec![255u8]));`);
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: `Err(
    Utf8Error {
        valid_up_to: 0,
        error_len: Some(
            1,
        ),
    },
)
Err(
    FromUtf8Error {
        bytes: [
            255,
        ],
        error: Utf8Error {
            valid_up_to: 0,
            error_len: Some(
                1,
            ),
        },
    },
)
`,
  });
});

test('applies capture modes separately to moved and borrowed fields', () => {
  const program = `struct Pair { a: String, b: String }
fn main() {
    let p = Pair { a: String::from("a"), b: String::from("b") };
    let f = || { drop(p.a); println!("{}", p.b); };
    f();
    println!("{}", p.b);
    let mut q = (String::from("x"), String::from("y"));
    let g = || { drop(q.0); q.1.push('!'); };
    g();
    println!("{}", q.1);
}`;
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: 'b\nb\ny!\n' });
  const conflicting = program.replace('    g();', "    q.1.push('?');\n    g();");
  expect(executeProgram('rust', conflicting)).toMatchObject({ kind: 'compileError' });
});

test('leaves ignored destructuring fields outside a closure environment', () => {
  const program = `struct Pair { a: String, b: String }
fn size<T>(_: &T) -> usize { std::mem::size_of::<T>() }
fn main() {
    let t = (String::from("ok"), [0u8; 64]);
    let no_tuple = move || { let (_, _) = t; };
    let p = Pair { a: String::from("still owned"), b: String::new() };
    let no_struct = move || { let Pair { a: _, b: _ } = p; };
    println!("{} {} {} {}", size(&no_tuple), size(&no_struct), t.0, p.a);
    drop(t);
    drop(p);
    no_tuple();
    no_struct();
}`;
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: '0 0 ok still owned\n' });
});

test('checks conditional impl bounds again when inference fills the generic arguments', () => {
  const program = `trait Marker {}
struct Wrap<T>(T);
struct NoClone;
impl<T: Clone> Marker for Wrap<T> {}
fn check<T: Marker>(_: &T) {}
fn main() {
    let mut w = Wrap(Vec::new());
    check(&w);
    w.0.push(NoClone);
}`;
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'compileError' });
  expect(executeProgram('rust', program.replace('struct NoClone;', '#[derive(Clone)] struct NoClone;'))).toMatchObject({
    kind: 'executed',
  });
});

test('calls Turtle::new through a function value and a standard iterator factory', () => {
  const program = rustMain(`let create = Turtle::new;
    let mut first = create();
    first.forward();
    let mut batch = std::iter::repeat_with(Turtle::new).take(1).collect::<Vec<Turtle>>();
    batch[0].turn_right();
    batch[0].forward();`);
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    finalTurtles: [
      { x: 0, y: 1 },
      { x: 1, y: 0 },
    ],
  });
});

test('checks reserved words consistently across Rust identifier positions', () => {
  for (const [items, body] of [
    ['struct Stats { gen: i32 }', 'let stats = Stats { gen: 1 }; println!("{}", stats.gen);'],
    ['mod gen {}', ''],
    ['trait gen {}', ''],
    ['struct gen;', ''],
    ['struct Generic<gen>(gen);', ''],
  ] as const) {
    expect(executeProgram('rust', rustMain(body, items))).toMatchObject({
      kind: 'compileError',
      diagnostics: expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining('予約語') })]),
    });
  }
  const escaped = rustMain(
    'let stats = r#gen::Stats { r#gen: 1 }; println!("{}", stats.r#gen);',
    'mod r#gen { pub struct Stats { pub r#gen: i32 } }'
  );
  expect(executeProgram('rust', escaped)).toMatchObject({ kind: 'executed', stdout: '1\n' });
});

test('permits opaque refinement only where a trait result declares it', () => {
  const program = `use std::fmt::{Display, Debug};
trait Source { fn value(&self) -> Option<impl Display>; }
struct S;
impl Source for S { fn value(&self) -> Option<impl Display + Debug> { Some(4) } }
fn read<T: Source>(s: &T) { println!("{}", s.value().unwrap()); }
fn main() { read(&S); }`;
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: '4\n' });
  const concrete = program.replace('Option<impl Display>;', 'Option<i32>;');
  const wrongShape = program.replace('-> Option<impl Display + Debug> { Some(4) }', '-> impl Display { 4 }');
  const missingBound = program.replace('impl Display + Debug', 'impl Debug');
  for (const source of [concrete, wrongShape, missingBound]) {
    expect(executeProgram('rust', source)).toMatchObject({ kind: 'compileError' });
  }
});

test('checks inline and where bounds of generic traits in defaults and implementations', () => {
  const program = `use std::fmt::Display;
trait Print<T: Display> { fn show(&self, value: T) { println!("{}", value); } }
trait Show<T> where T: Display { fn log(&self, value: T) { println!("{}", value); } }
struct Printer;
struct Missing;
impl Print<i32> for Printer {}
impl Show<&str> for Printer {}
fn main() { Printer.show(3); Printer.log("text"); }`;
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: '3\ntext\n' });
  const invalid = program.replace('fn main()', 'impl Print<Missing> for Printer {} fn main()');
  expect(executeProgram('rust', invalid)).toMatchObject({ kind: 'compileError' });
});

test('evaluates HashSet membership only as lazy set iterators are consumed or formatted', () => {
  const program = `use std::collections::HashSet;
#[derive(Clone, Debug, Eq, Hash)]
struct K(i32);
impl PartialEq for K {
    fn eq(&self, other: &Self) -> bool {
        print!("eq ");
        self.0 == other.0
    }
}
fn main() {
    let a = HashSet::from([K(1)]);
    let b = HashSet::from([K(1)]);
    let unused = a.difference(&b);
    println!("ready");
    drop(unused);
    let mut common = a.intersection(&b);
    let copy = common.clone();
    println!("{:?}", copy);
    println!("{:?}", common.next());
    println!("{:?}", common);
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: 'ready\n[eq K(1)]\neq Some(K(1))\n[]\n',
  });
});

test('roots iterator-owned accumulations while discarding inputs that count does not retain', () => {
  const items = `let observer = Turtle::new(0, 0);
    let iter = vec![Turtle::new(0, 1), Turtle::new(2, 1)].into_iter()
        .map(|t| { println!("{}", observer.can_move_forward()); t });`;
  for (const finish of [
    'let kept: Vec<_> = iter.collect(); println!("{} {}", kept.len(), observer.can_move_forward());',
    'let kept: Option<Vec<_>> = iter.map(Some).collect(); let kept = kept.unwrap(); println!("{} {}", kept.len(), observer.can_move_forward());',
    'let (yes, no): (Vec<_>, Vec<_>) = iter.partition(|_| true); println!("{} {}", yes.len() + no.len(), observer.can_move_forward());',
    'let kept = iter.fold(Vec::new(), |mut kept, t| { kept.push(t); kept }); println!("{} {}", kept.len(), observer.can_move_forward());',
  ]) {
    expect(executeProgram('rust', rustMain(`${items}\n${finish}`))).toMatchObject({
      kind: 'executed',
      stdout: 'false\nfalse\n2 false\n',
    });
  }
  const count = rustMain(`${items}\nprintln!("{}", iter.count());`);
  expect(executeProgram('rust', count)).toMatchObject({ kind: 'executed', stdout: 'false\ntrue\n2\n' });
});

test('evaluates indexed places even when destructuring ignores their fields', () => {
  const program = rustMain(`let a = [(1, 2)];
    let b = vec![(3, 4)];
    let index = 0usize;
    let f = move || { let (_, _) = a[index]; let (_, _) = b[index]; println!("ok"); };
    f();`);
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: 'ok\n' });
  const outOfRange = program.replace('0usize', '1usize');
  expect(executeProgram('rust', outOfRange)).toMatchObject({
    kind: 'executed',
    uncaughtException: expect.stringContaining('the len is 1 but the index is 1'),
  });
});

test('requires a declared or static lifetime for each stored reference field', () => {
  for (const declaration of [
    'struct S { f: &str }',
    'struct S((&str, u8));',
    'enum E { A([&str; 2]) }',
    "struct S { f: &'_ str }",
    "struct S<'a> { f: &'other str }",
  ]) {
    expect(executeProgram('rust', rustMain('', declaration))).toMatchObject({ kind: 'compileError' });
  }
  const valid = rustMain(
    'println!("{}", S { f: "accepted" }.f);',
    "struct S<'a> { f: &'a str } enum E { A(&'static str) }"
  );
  expect(executeProgram('rust', valid)).toMatchObject({ kind: 'executed', stdout: 'accepted\n' });
});

test('uses known enum discriminants without propagating payloads into the panic lint', () => {
  const possiblyReached = rustMain('let o = Some(1); if let Some(2) = o { let a = [1, 2]; let _x = a[3]; }');
  expect(executeProgram('rust', possiblyReached)).toMatchObject({ kind: 'compileError' });
  const runtimePanic = rustMain('println!("run"); let o = Some(3u8); if let Some(x) = o { let _x = 255u8 + x; }');
  expect(executeProgram('rust', runtimePanic)).toMatchObject({
    kind: 'executed',
    stdout: 'run\n',
    uncaughtException: expect.stringContaining('attempt to add with overflow'),
  });
  const unreachable = rustMain('let o: Option<i32> = None; if let Some(_) = o { let a = [1, 2]; let _x = a[3]; }');
  expect(executeProgram('rust', unreachable)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
});

test('pops the last Unicode scalar and preserves byte length and capacity', () => {
  const program = rustMain(`let mut s = String::with_capacity(20);
    s.push_str("aé🙂");
    println!("{:?} {} {}", s.pop(), s.len(), s.capacity());
    println!("{:?} {} {}", s.pop(), s.len(), s.capacity());
    println!("{:?} {:?} {}", s.pop(), s.pop(), s.capacity());`);
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: "Some('🙂') 3 20\nSome('é') 1 20\nSome('a') None 20\n",
  });
});

test('sizes arrays using typed constant fields and indexed values', () => {
  const program = `const GRID: [[i32; 2]; 3] = [[1, 2], [3, 4], [5, 6]];
const WORDS: [&str; 2] = ["a", "bc"];
const SLICES: [&[i32]; 2] = [&[1], &[2, 3]];
const COUNTS: [usize; 2] = [2, 3];
const PAIR: (usize, u8) = (2, 1);
const WIDTH: usize = GRID[0].len();
fn main() {
    let row: [i32; GRID[0].len()] = [0; WIDTH];
    let a = [0; WORDS[1].len()];
    let b = [0; SLICES[1].len()];
    let c: [i32; COUNTS[1]] = [0; 3];
    let d = [0; PAIR.0];
    println!("{} {} {} {} {}", row.len(), a.len(), b.len(), c.len(), d.len());
}`;
  expect(executeProgram('rust', program)).toMatchObject({ kind: 'executed', stdout: '2 2 2 3 2\n' });
  const outOfRange = program.replace('COUNTS[1]]', 'COUNTS[2]]');
  const wrongWidth = program.replace('PAIR.0]', 'PAIR.1]');
  expect(executeProgram('rust', outOfRange)).toMatchObject({ kind: 'compileError' });
  expect(executeProgram('rust', wrongWidth)).toMatchObject({ kind: 'compileError' });
});

test('formats the input items of Map when its callable returns a different type', () => {
  const program = `fn stringify(x: i32) -> String { x.to_string() }
fn letter(_: i32) -> char { 'a' }
fn show<F: Fn(i32) -> char>(f: F) {
    println!("{:?}", [3, 4].into_iter().map(f));
}
fn main() {
    println!("{:?}", [1, 2].into_iter().map(stringify));
    show(letter);
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: 'Map { iter: IntoIter([1, 2]) }\nMap { iter: IntoIter([3, 4]) }\n',
  });
});

test('calls element inequality for standard sequences and tuples', () => {
  const program = `use std::collections::VecDeque;
struct K(i32);
impl PartialEq for K {
    fn eq(&self, other: &Self) -> bool { print!("eq "); self.0 == other.0 }
    fn ne(&self, other: &Self) -> bool { print!("ne "); self.0 != other.0 }
}
fn main() {
    println!("vec {}", vec![K(1)] != vec![K(1)]);
    println!("array {}", [K(1)] != [K(1)]);
    println!("slice {}", [K(1)][..] != [K(1)][..]);
    println!("tuple {}", (1, K(1)) != (1, K(1)));
    println!("deque {}", VecDeque::from([K(1)]) != VecDeque::from([K(1)]));
    println!("option {}", Some(K(1)) != Some(K(1)));
}`;
  expect(executeProgram('rust', program)).toMatchObject({
    kind: 'executed',
    stdout: 'ne vec false\nne array false\nne slice false\nne tuple false\nne deque false\neq option false\n',
  });
});
