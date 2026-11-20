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
    'materialized hash set operation iterators',
    'let _allocated = vec![0; 999_945]; let a: std::collections::HashSet<_> = (0..15).collect(); let b: std::collections::HashSet<_> = (15..30).collect(); let _union = a.union(&b);',
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
