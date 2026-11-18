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

test.each([
  ['range patterns (stage C)', '    match 3 { 1..=5 => {}, _ => {} }'],
  ['threads (stage D)', '    std::thread::spawn(|| {});'],
  ['standard input (stage D)', '    let mut s = String::new();\n    std::io::stdin().read_line(&mut s).unwrap();'],
  ['operator overloading (stage C)', '', 'struct P;\nimpl std::ops::Add for P { fn add(self, o: P) -> P { o } }'],
])('%s are unavailable', (_name, body, items = '') => {
  const execution = executeProgram('rust', rustMain(body, items));
  expect(execution.kind).toBe('compileError');
  expect(execution.kind === 'compileError' && execution.diagnostics[0].message).toMatch(
    /この採点環境では使えません。$/
  );
});

test('an endless loop stops at the operation limit', () => {
  expect(executeProgram('rust', rustMain('    let mut i: u64 = 0;\n    loop { i = i.wrapping_add(1); }'))).toEqual({
    kind: 'limitExceeded',
    limit: 'operations',
  });
});
