import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

// .NET 10.0.403 (`dotnet run` on the file, culture ja-JP) prints the expected output: the shortest round-trip doubles
// and their switch to scientific notation, ja-JP's number formats, decimal's trailing zeros, and banker's rounding.
test('numbers print as .NET prints them', () => {
  const program = String.raw`double third = 1.0 / 3;
Console.WriteLine($"{third} {0.1 + 0.2} {1e16} {1e17} {0.0001} {0.00001} {2.5f * 3} {-0.0}");
Console.WriteLine($"{1234.5:N} {0.125:P} {-1234.5:C} {2.5:F0} {3.5:F0} {0.125:0.00} {7:D3} {255:X4} {1e-7:E2}");
Console.WriteLine($"[{"ab",5}|{"ab",-5}|{3.14159,8:F2}] {1.50m} {1.50m * 2} {10m / 3} {Math.Round(2.5)} {Math.Round(2.5m)}");
Console.WriteLine(string.Format("{0} + {1} = {2}", 1, 2.0, 3m) + $" {true} {'x'} {(object?)null}");
`;
  expect(executeProgram('csharp', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: [
      '0.3333333333333333 0.30000000000000004 10000000000000000 1E+17 0.0001 1E-05 7.5 -0',
      '1,234.500 12.500% -¥1,234 2 4 0.13 007 00FF 1.00E-007',
      '[   ab|ab   |    3.14] 1.50 3.00 3.3333333333333333333333333333 2 2',
      '1 + 2 = 3 True x ',
      '',
    ].join('\n'),
  });
});

// .NET fixes these orders: a dictionary reuses the latest freed entry first, List.Sort is an unstable introsort while
// OrderBy is stable, and a seeded Random follows its subtractive generator. LINQ queries print their iterator's name.
test('collections, sorting, and seeded random numbers follow .NET', () => {
  const program = String.raw`var d = new Dictionary<string, int> { ["a"] = 1, ["b"] = 2, ["c"] = 3 };
d.Remove("a"); d.Remove("b"); d["x"] = 9; d["y"] = 8;
Console.WriteLine(string.Join(",", d.Select(kv => $"{kv.Key}={kv.Value}")));
var xs = new List<(int Key, string Name)>();
for (int i = 0; i < 20; i++) xs.Add((i % 3, "n" + i));
xs.Sort((p, q) => p.Key.CompareTo(q.Key));
Console.WriteLine(string.Join(" ", xs.Select(p => p.Name)));
Console.WriteLine(string.Join(" ", Enumerable.Range(0, 20).Select(i => (Key: i % 3, Name: "n" + i)).OrderBy(p => p.Key).Select(p => p.Name)));
var r = new Random(42);
Console.WriteLine($"{r.Next()} {r.Next(10)} {r.Next(5, 15)} {r.NextDouble()}");
object q = new List<int> { 3, 1 }.Where(x => x > 0);
Console.WriteLine($"{q} {new List<int>()} {new[] { 1 }} {(1, "a")} {new Dictionary<int, int>()}");
Console.WriteLine(System.Text.RegularExpressions.Regex.Replace("2024-05-06", @"(?<y>\d+)-(\d+)-(\d+)", "$2/$3/${'$'}{y}"));
`;
  expect(executeProgram('csharp', program)).toMatchObject({
    kind: 'executed',
    stdout: [
      'y=8,x=9,c=3',
      'n0 n15 n12 n18 n6 n9 n3 n4 n7 n10 n13 n1 n16 n19 n8 n11 n2 n14 n17 n5',
      'n0 n3 n6 n9 n12 n15 n18 n1 n4 n7 n10 n13 n16 n19 n2 n5 n8 n11 n14 n17',
      '1434747710 1 6 0.5227642760252413',
      'System.Linq.Enumerable+ListWhereIterator`1[System.Int32] System.Collections.Generic.List`1[System.Int32] System.Int32[] (1, a) System.Collections.Generic.Dictionary`2[System.Int32,System.Int32]',
      '06/2024/2024',
      '',
    ].join('\n'),
  });
});

// A type's static initializer runs at its first use, records print and compare by value, and an uncaught exception
// ends the program with its type, message, and inner exception, as .NET's unhandled-exception handler prints them.
test('static initialization, records, virtual calls, and an uncaught exception behave as in .NET', () => {
  const program = String.raw`Console.WriteLine("start");
Console.WriteLine(Registry.Count);
var p = new Point(1, 2);
var moved = p with { Y = 5 };
Console.WriteLine($"{p} {moved} {p == new Point(1, 2)} {new Line(p, moved)}");
var (x, y) = moved;
Console.WriteLine(x + y);
Shape s = new Circle(2);
Console.WriteLine($"{s.Area():F3} {s} {s.Describe()}");
throw new InvalidOperationException("stop here", new FormatException("inner"));
static class Registry { public static int Count = Init(); static int Init() { Console.WriteLine("init"); return 3; } }
record Point(int X, int Y);
record Line(Point From, Point To);
abstract class Shape { public abstract double Area(); public virtual string Describe() => "shape"; }
class Circle : Shape { double r; public Circle(double r) { this.r = r; } public override double Area() => Math.PI * r * r; public override string Describe() => "circle, not " + base.Describe(); }
`;
  const exception =
    'System.InvalidOperationException: stop here\n ---> System.FormatException: inner\n   --- End of inner exception stack trace ---';
  expect(executeProgram('csharp', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: exception,
    stdout: [
      'start',
      'init',
      '3',
      'Point { X = 1, Y = 2 } Point { X = 1, Y = 5 } True Line { From = Point { X = 1, Y = 2 }, To = Point { X = 1, Y = 5 } }',
      '6',
      '12.566 Circle circle, not shape',
      '',
    ].join('\n'),
  });
});

// .NET makes a new string for each result, except where it returns one it has: an operand that the others leave as
// it is, a cached small number or enum name, an interned literal. ja-JP compares ignoring case with the rules that
// .NET adds to ICU's, and ICU's search matches between grapheme clusters, weighing `ー` after the kana before it.
// Searches compare collation elements, with their case bits and with compatibility characters' root expansions.
test('strings are the same object and compare as in .NET', () => {
  const program = String.raw`static bool R(object a, object b) => ReferenceEquals(a, b);
string b = "a"; string e = ""; int i = 1;
string c = b + "b";
Console.WriteLine($"{R(c, "ab")} {R(c + e, c)} {R(c + e + e + e + e, c)} {R($"{c}{e}", c)} {R($"{c,0}", c)} {R(c.Trim(), c)} {R(c.ToUpper().ToLower(), c)}");
Console.WriteLine($"{R(i.ToString(), "" + i)} {R(299.ToString(), 299.ToString())} {R(300.ToString(), 300.ToString())} {R(true.ToString(), "True")} {R(DayOfWeek.Monday.ToString(), DayOfWeek.Monday.ToString())} {R(c.Split(',')[0], c)} {R(string.Join(",", new[] { c }), c)}");
Console.WriteLine($"{string.Compare("カ", "ガ", true)} {string.Compare("ｱ", "ァ", true)} {string.Compare("Ａ", "ａ", true)} {string.Compare("ー", "ｰ", true)} {string.Equals("ぷー", "ぷう", StringComparison.CurrentCultureIgnoreCase)} {"ルﾟu".IndexOf("ル")} {"ァヽb".IndexOf("ヽb")} {"­カ".IndexOf("カ")} {"abcabc".LastIndexOf("bc", 6)}");
var ic = StringComparison.CurrentCultureIgnoreCase;
Console.WriteLine($"{string.Compare("ﾩ", "ㄹ")} {"ﾩ".StartsWith("ㄹ")} {"ǆ".StartsWith("d", ic)} {"ŀ".StartsWith("l", ic)} {"㍢".StartsWith("1", ic)} {"㍢".EndsWith("点", ic)} {"㌀".StartsWith("あ", ic)}");
`;
  expect(executeProgram('csharp', program)).toMatchObject({
    kind: 'executed',
    stdout: [
      'False True False True False True False',
      'True True False True True True True',
      '-1 -1 0 0 True -1 -1 1 4',
      '0 False True False True False True',
      '',
    ].join('\n'),
  });
});

// Roslyn's Japanese messages, each on the row it reports. Roslyn reports the unassigned local last, as its flow
// analysis runs after binding, which the sorting by row hides.
test('compile errors carry Roslyn codes and messages', () => {
  const program = `int count = "3";
string name;
Console.WriteLine(name);
Console.WriteLine(Twice(2, 3));
"x".Jump();
static int Twice(int x) { if (x > 0) return x * 2; }
`;
  const result = executeProgram('csharp', program);
  expect(result.kind).toBe('compileError');
  if (result.kind !== 'compileError') return;
  expect(result.diagnostics.toSorted((a, b) => a.row - b.row)).toEqual([
    { row: 0, message: "CS0029: 型 'string' を 'int' に暗黙的に変換できません" },
    { row: 2, message: "CS0165: 未割り当てのローカル変数 'name' が使用されました" },
    { row: 3, message: "CS1501: 引数 2 を指定するメソッド 'Twice' のオーバーロードはありません" },
    {
      row: 4,
      message:
        "CS1061: 'string' に 'Jump' の定義が含まれておらず、型 'string' の最初の引数を受け付けるアクセス可能な拡張メソッド 'Jump' が見つかりませんでした。using ディレクティブまたはアセンブリ参照が不足していないことを確認してください",
    },
    { row: 5, message: "CS0161: 'Twice(int)': 値を返さないコード パスがあります" },
  ]);
});

// tree-sitter recovers from these mistakes differently from Roslyn, so each is translated to Roslyn's error.
test.each([
  {
    program: 'Console.WriteLine("x")\nConsole.WriteLine("y");\n',
    expected: { row: 0, message: 'CS1002: ; が必要です' },
  },
  { program: 'int x = 5\nint y = 6;\n', expected: { row: 0, message: "CS1003: 構文エラーです。',' が必要です" } },
  { program: 'if (true {\n  Console.WriteLine(1);\n}\n', expected: { row: 0, message: 'CS1026: ) が必要です' } },
  {
    program: 'for (int i = 0; i < 3; i++)\n{\n    Console.WriteLine(i);\n',
    expected: { row: 2, message: 'CS1513: } が必要です' },
  },
  { program: 'int x = 3 +;\n', expected: { row: 0, message: "CS1525: ';' は無効です" } },
  ...['x + y;', 'x > 1 ? 1 : 2;', 'x switch { _ => 1 };', 'if (x > 0) x * 2;', 'x.ToString;'].map((statement) => ({
    program: `int x = 1, y = 2;\n${statement}\n`,
    expected: {
      row: 1,
      message:
        'CS0201: 代入、呼び出し、インクリメント、デクリメント、新しいオブジェクトの式のみがステートメントとして使用できます',
    },
  })),
])('a syntax error is reported as Roslyn reports it: $expected.message', ({ program, expected }) => {
  expect(executeProgram('csharp', program)).toEqual({ kind: 'compileError', diagnostics: [expected] });
});

// Learners' programs run in a browser's interpreter worker: work that the host cannot interrupt (a backtracking regex, a lazy
// sequence, a culture search) must count against the budget, and a run must not see what an earlier run did.
test('hostile programs stop within the limits, and runs share no state', () => {
  for (const program of [
    'Console.WriteLine(System.Text.RegularExpressions.Regex.IsMatch(new string(\'a\', 40) + "!", "^(a+)+$"));',
    'Console.WriteLine(Enumerable.Range(0, int.MaxValue).Count());',
    'var s = new string(\'あ\', 999999); Console.WriteLine(s.IndexOf(s + "い"));',
  ]) {
    // Which limit stops the program first depends on the machine's speed.
    expect(executeProgram('csharp', program)).toMatchObject({
      kind: 'limitExceeded',
      limit: expect.stringMatching(/^(operations|time)$/),
    });
  }
  expect(
    executeProgram(
      'csharp',
      'var s = new string(\'あ\', 999999); Console.WriteLine($"{s.EndsWith("い")} {s.StartsWith(s + "い")}");'
    )
  ).toMatchObject({ kind: 'executed', stdout: 'False False\n' });
  // .NET 10 gives these hash codes to the first objects of every run; an interpolated string's buffer takes one.
  const hashCodes =
    'Console.WriteLine($"{new object().GetHashCode()} {new object().GetHashCode()}"); Console.WriteLine(new object().GetHashCode());';
  for (let run = 0; run < 2; run++)
    expect(executeProgram('csharp', hashCodes)).toMatchObject({ stdout: '58225482 54267293\n33574638\n' });
});

// Console reads standard input and writes standard error, and System.IO works on the run's virtual file system, whose
// working directory is `/`. A StreamWriter holds 1024 characters, then its FileStream 4096 bytes, as .NET's do, so
// what a program never flushes is lost.
test('standard input, standard error, and files behave as in .NET', () => {
  const reading = String.raw`int n = int.Parse(Console.ReadLine()!);
int[] xs = Console.ReadLine()!.Split(' ').Select(int.Parse).ToArray();
Console.WriteLine($"{n} {xs.Sum()} {Console.ReadLine() == null}");
Console.Error.WriteLine("warning");
File.WriteAllLines("out/a.txt", xs.Select(x => $"{x * x}"));
`;
  expect(executeProgram('csharp', reading, { stdin: '3\n1 2 3\n' })).toMatchObject({
    kind: 'executed',
    stdout: '3 6 True\n',
    stderr:
      "warning\nUnhandled exception. System.IO.DirectoryNotFoundException: Could not find a part of the path '/out/a.txt'.\n",
    finalFiles: {},
  });
  const files = String.raw`Directory.CreateDirectory("out");
File.WriteAllLines("out/a.txt", new[] { "1", "4" });
File.AppendAllText("out/a.txt", "9");
Console.WriteLine(string.Join("+", File.ReadAllLines("out/a.txt")));
var w = new StreamWriter("out/b.txt");
w.Write(new string('x', 5000));
Console.WriteLine($"{File.ReadAllText("out/b.txt").Length} {Path.GetExtension("out/b.txt")}");
try { File.ReadAllText("none.txt"); } catch (FileNotFoundException e) { Console.WriteLine(e.Message); }
using (var u = new StreamWriter("out/c.txt")) u.Write("kept");
var lost = new StreamWriter("out/d.txt");
lost.Write("lost");
`;
  expect(executeProgram('csharp', files)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: "1+4+9\n0 .txt\nCould not find file '/none.txt'.\n",
    finalFiles: { 'out/a.txt': '1\n4\n9', 'out/b.txt': '', 'out/c.txt': 'kept', 'out/d.txt': '' },
  });
});

// One thread runs every task: Task.Run work waits until the running code awaits, timers fire by a virtual clock, and
// WhenAll gathers exceptions in the order the tasks faulted. A wait that nothing can end is a deadlock, an error.
test('async methods and tasks run in a fixed order', () => {
  const program = String.raw`var slow = Work("slow", 30);
var fast = Work("fast", 10);
var run = Task.Run(() => { Console.WriteLine("run"); return 7; });
Console.WriteLine("main");
int[] results = await Task.WhenAll(slow, fast);
Console.WriteLine($"{string.Join(",", results)} {await run}");
try { await Task.WhenAll(Fail("a"), Fail("b")); }
catch (Exception e) { Console.WriteLine(e.Message); }
await foreach (var n in Count(2)) Console.WriteLine($"n{n}");

static async Task<int> Work(string name, int ms)
{ Console.WriteLine($"{name} start"); await Task.Delay(ms); Console.WriteLine($"{name} end"); return ms; }

static async Task Fail(string message)
{ await Task.Delay(message == "a" ? 30 : 1); throw new InvalidOperationException(message); }

static async IAsyncEnumerable<int> Count(int count)
{ for (int i = 0; i < count; i++) { await Task.Delay(1); yield return i; } }
`;
  expect(executeProgram('csharp', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: ['slow start', 'fast start', 'main', 'run', 'fast end', 'slow end', '30,10 7', 'b', 'n0', 'n1', ''].join(
      '\n'
    ),
  });
  expect(
    executeProgram('csharp', 'Console.WriteLine("wait");\nawait new TaskCompletionSource().Task;\n')
  ).toMatchObject({
    kind: 'executed',
    stdout: 'wait\n',
    uncaughtException: 'デッドロックが起きました。すべてのスレッドやタスクが待ったままで、どれも先に進めません。',
  });
});

// A program's awaiter gets the continuation after the method suspends, so a synchronous call of it resumes the method
// inside OnCompleted; a struct awaiter's OnCompleted runs on a copy; a continuation invoked after its method ended
// throws as .NET's does, and one that nothing invokes leaves a deadlock.
test('awaits of awaiters that the program declares resume through their continuations', () => {
  const program = String.raw`using System.Runtime.CompilerServices;
Console.WriteLine(await new Now(1) + await new Later(2));
Console.WriteLine(await "four");
dynamic d = new Now(5);
Console.WriteLine(await d);
var counter = new Counter();
Console.WriteLine(await counter);
try { await new Now(-1); } catch (InvalidOperationException e) { Console.WriteLine(e.Message); }
await Once();
await Task.Delay(1);
Later.Saved!();
static async Task Once() => Console.WriteLine(await new Later(6));
static class Ext { public static TaskAwaiter<int> GetAwaiter(this string s) => Task.FromResult(s.Length).GetAwaiter(); }
class Now(int value) : INotifyCompletion
{
    public Now GetAwaiter() => this;
    public bool IsCompleted => false;
    public int GetResult() => value < 0 ? throw new InvalidOperationException("bad") : value;
    public void OnCompleted(Action c) { Console.WriteLine("in"); c(); Console.WriteLine("out"); }
}
class Later(int value) : INotifyCompletion
{
    public static Action? Saved;
    public Later GetAwaiter() => this;
    public bool IsCompleted => false;
    public int GetResult() => value;
    public void OnCompleted(Action c) { Saved = c; Task.Delay(10).ContinueWith(_ => c()); }
}
class Counter { public CounterAwaiter GetAwaiter() => new(); }
struct CounterAwaiter : INotifyCompletion
{
    int calls;
    public bool IsCompleted => ++calls > 1;
    public int GetResult() => calls;
    public void OnCompleted(Action c) { calls += 100; Task.Run(c); }
}
`;
  expect(executeProgram('csharp', program)).toMatchObject({
    kind: 'executed',
    stdout: ['in', 'out', '3', '4', 'in', '5', 'out', '1', 'in', 'bad', 'out', '6', ''].join('\n'),
    uncaughtException: 'System.NullReferenceException: Object reference not set to an instance of an object.',
  });
  const never = String.raw`using System.Runtime.CompilerServices;
await new Never();
class Never : INotifyCompletion
{
    public Never GetAwaiter() => this;
    public bool IsCompleted => false;
    public void GetResult() { }
    public void OnCompleted(Action c) => Console.WriteLine("dropped");
}
`;
  expect(executeProgram('csharp', never)).toMatchObject({
    kind: 'executed',
    stdout: 'dropped\n',
    uncaughtException: 'デッドロックが起きました。すべてのスレッドやタスクが待ったままで、どれも先に進めません。',
  });
});

// Unsafe code, with `AllowUnsafeBlocks`, reads and writes through pointers to locals, fixed arrays and strings, stack
// buffers, and struct fields, reinterpreting bytes little-endian as .NET does; without it, `unsafe` is CS0227.
test('unsafe code runs with pointers, fixed, and stackalloc', () => {
  const program = String.raw`#:property AllowUnsafeBlocks=true
unsafe
{
    int x = 5;
    int* p = &x;
    *p += 2;
    Console.WriteLine($"{x} {*p} {p == &x} {p != null}");
    int[] a = { 1, 2, 3, 4 };
    fixed (int* q = a)
    {
        int* r = q + 1;
        *r = 20;
        r++;
        r[1] = 40;
        Console.WriteLine($"{*q} {q[1]} {*(q + 2)} {r - q} {r > q}");
        for (int* s = q; s < q + a.Length; s++) *s *= 10;
    }
    Console.WriteLine(string.Join(",", a));
    int* buf = stackalloc int[3];
    for (int i = 0; i < 3; i++) buf[i] = i * i;
    Console.WriteLine(buf[0] + buf[1] + buf[2]);
    Point pt = new Point { X = 1, Y = 2 };
    Point* pp = &pt;
    pp->X = 9;
    (*pp).Y = 8;
    Console.WriteLine($"{pt.X} {pt.Y} {pp->X + pp->Y}");
    Console.WriteLine($"{sizeof(Point)} {sizeof(int*) } {sizeof(long)}");
    fixed (char* c = "hello") Console.WriteLine(c[1]);
    byte* bp = (byte*)&x;
    Console.WriteLine(bp[0]);
    void* vp = &x;
    Console.WriteLine(*(int*)vp);
    delegate*<int, int> f = &Twice;
    Console.WriteLine(f(21));
    int** pp2 = &p;
    **pp2 = 100;
    Console.WriteLine(x);
}
static int Twice(int v) => v * 2;
struct Point { public int X; public int Y; }
`;
  expect(executeProgram('csharp', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: [
      '7 7 True True',
      '1 20 3 2 True',
      '10,200,30,400',
      '5',
      '9 8 17',
      '8 8 8',
      'e',
      '7',
      '7',
      '42',
      '100',
      '',
    ].join('\n'),
  });
  expect(executeProgram('csharp', 'unsafe { int x = 1; }\n')).toEqual({
    kind: 'compileError',
    diagnostics: [{ row: 0, message: 'CS0227: アンセーフ コードは /unsafe でコンパイルした場合のみ有効です' }],
  });
});

// A `dynamic` operation binds when it runs, to the types of the values: overloads, operators, and members, with the
// runtime binder's messages for what does not bind. The runtime binder finds no extension methods.
test('dynamic values bind at run time as .NET binds them', () => {
  const program = String.raw`dynamic a = 3, s = "x";
dynamic p = new P { X = 2 };
p.X = p.X * 3;
a += 10;
a++;
Console.WriteLine($"{s + a} {p.Show(5)} {p.Show("v")} {a == 14} {Math.Max(a, 100)}");
try { s.Missing(); } catch (Exception e) { Console.WriteLine(e.Message); }
try { Console.WriteLine(a - s); } catch (Exception e) { Console.WriteLine(e.Message); }
try { int k = s; } catch (Exception e) { Console.WriteLine(e.Message); }
dynamic none = null;
none.ToString();
class P
{ public int X { get; set; } public string Show(string v) => "s:" + v; public string Show(int v) => "i:" + v; }
`;
  expect(executeProgram('csharp', program)).toMatchObject({
    kind: 'executed',
    stdout: [
      'x14 i:5 s:v True 100',
      "'string' does not contain a definition for 'Missing'",
      "Operator '-' cannot be applied to operands of type 'int' and 'string'",
      "Cannot implicitly convert type 'string' to 'int'",
      '',
    ].join('\n'),
    uncaughtException:
      'Microsoft.CSharp.RuntimeBinder.RuntimeBinderException: Cannot perform runtime binding on a null reference',
  });
  expect(executeProgram('csharp', 'dynamic d = new List<int>();\nd.Select(x => x);\n')).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 1, message: expect.stringContaining('CS1977') }],
  });
});

// `?.` and invoking a delegate work on `dynamic` values, a call passes `ref` and `out` variables, `await` takes a
// task held as `dynamic`, and the runtime binder names the overloads it finds ambiguous as .NET does.
test('dynamic invocations, ref arguments, and await bind at run time as .NET binds them', () => {
  const program = String.raw`dynamic c = new C(), none = null, f = (Func<int, int>)(x => x + 1);
Console.WriteLine($"{c?.Name} {none?.Name == null} {f(2)}");
int got, count = 1;
c.Get(5, out got);
c.Inc(ref count);
Console.WriteLine($"{got} {count} {await (dynamic)Later()}");
try { var nothing = c.Inc(ref count); } catch (Exception e) { Console.WriteLine(e.Message); }
try { f("x"); } catch (Exception e) { Console.WriteLine(e.Message); }
Console.WriteLine(none);
static async Task<string> Later() { await Task.Yield(); return "later"; }
class C {
    public string Name => "c";
    public void Get(int x, out int y) { y = x * 3; }
    public void Inc(ref int x) { x++; }
}
`;
  expect(executeProgram('csharp', program)).toMatchObject({
    kind: 'executed',
    stdout: [
      'c True 3',
      '15 2 later',
      "Cannot implicitly convert type 'void' to 'object'",
      "Delegate 'System.Func<int,int>' has some invalid arguments",
      '',
    ].join('\n'),
    uncaughtException:
      "Microsoft.CSharp.RuntimeBinder.RuntimeBinderException: The call is ambiguous between the following methods or properties: 'System.Console.WriteLine(string, params object[])' and 'System.Console.WriteLine(char[])'",
  });
  expect(executeProgram('csharp', 'dynamic d = 1;\nint.TryParse(d, out var n);\n')).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 1, message: "CS8197: 暗黙的に型指定された out 変数 'n' の型を推論できません。" }],
  });
});

// A TypedReference refers to a variable, whose exact type `__refvalue` checks when it runs; as a ref struct, it may
// not be boxed or captured by a lambda. A UTF-8 string literal is a ReadOnlySpan<byte>, another ref struct.
test('typed references and UTF-8 string literals behave as ref structs do in .NET', () => {
  const program = String.raw`int x = 1;
TypedReference r = __makeref(x);
__refvalue(r, int) += 4;
Console.WriteLine($"{x} {__reftype(r)} {TypedReference.ToObject(r)}");
try { Console.WriteLine(__refvalue(r, long)); } catch (InvalidCastException e) { Console.WriteLine(e.Message); }
`;
  expect(executeProgram('csharp', program)).toMatchObject({
    kind: 'executed',
    stdout: ['5 System.Int32 5', 'Specified cast is not valid.', ''].join('\n'),
  });
  const utf8 = String.raw`var b = "hé"u8 + "!"u8;
Console.WriteLine($"{b.Length} {b[1]} {b.ToString()} {string.Join(",", b.ToArray())}");
foreach (var x in b[1..]) Console.Write(x + " ");
Console.WriteLine(System.Text.Encoding.UTF8.GetString(b));
`;
  expect(executeProgram('csharp', utf8)).toMatchObject({
    kind: 'executed',
    stdout: ['4 195 System.ReadOnlySpan<Byte>[4] 104,195,169,33', '195 169 33 hé!', ''].join('\n'),
  });
  expect(
    executeProgram(
      'csharp',
      'int x = 1;\nvar r = __makeref(x);\nobject o = r;\nFunc<int> f = () => __refvalue(r, int);\n'
    )
  ).toEqual({
    kind: 'compileError',
    diagnostics: [
      { row: 2, message: "CS0029: 型 'System.TypedReference' を 'object' に暗黙的に変換できません" },
      {
        row: 3,
        message:
          "CS4013: 型 'TypedReference' のインスタンスは、入れ子になった関数、クエリ式、反復子ブロック、または非同期メソッドの中では使用できません",
      },
    ],
  });
});

// A Main returning a task is an entry point whose task the program waits for; an async one returning void or int is
// not.
test('a class Main returning Task or Task<int> runs as the entry point and is waited for', () => {
  const program = String.raw`class Program {
    static async Task<int> Main(string[] args) {
        Console.WriteLine(args.Length);
        await Task.Delay(1);
        Console.WriteLine("after");
        throw new InvalidOperationException("boom");
    }
}
`;
  expect(executeProgram('csharp', program)).toMatchObject({
    kind: 'executed',
    stdout: ['0', 'after', ''].join('\n'),
    stderr: 'Unhandled exception. System.InvalidOperationException: boom\n',
  });
  expect(
    executeProgram('csharp', 'class Program {\n    static async void Main() { await Task.Delay(1); }\n}\n')
  ).toEqual({
    kind: 'compileError',
    diagnostics: [
      { row: 1, message: 'CS4009: エントリ ポイントを返す void または int を async にすることはできません' },
      { row: 0, message: "CS5001: プログラムは、エントリ ポイントに適切な静的 'Main' メソッドを含んでいません" },
    ],
  });
});

// `#line` moves the rows that compile errors and `[CallerLineNumber]` report, and directive errors come with the
// syntax errors in row order.
test('#line maps the rows of compile errors and caller line numbers as Roslyn does', () => {
  const caller = String.raw`using System.Runtime.CompilerServices;
#line 100
Show();
#line hidden
Show();
#line default
Show();
static void Show([CallerLineNumber] int line = 0) => Console.WriteLine(line);
`;
  expect(executeProgram('csharp', caller)).toMatchObject({ kind: 'executed', stdout: '100\n102\n7\n' });
  const errors =
    'int a = "x";\n#line 200\nint b = "y";\n#line (1,1)-(5,60) "f.cs"\nint c = "z";\n#line default\nint d = "w";\n';
  const conversion = "CS0029: 型 'string' を 'int' に暗黙的に変換できません";
  expect(executeProgram('csharp', errors)).toEqual({
    kind: 'compileError',
    diagnostics: [0, 199, 0, 6].map((row) => ({ row, message: conversion })),
  });
  expect(executeProgram('csharp', 'Console.WriteLine(1);\n#line 40\nint x = 1\n#line bad\n')).toEqual({
    kind: 'compileError',
    diagnostics: [
      { row: 39, message: 'CS1002: ; が必要です' },
      { row: 40, message: 'CS1576: #line ディレクティブの行数が指定されていないか、無効です' },
    ],
  });
  expect(executeProgram('csharp', '#if A\n#region r\n#endif\n#endregion\nConsole.WriteLine(1);\n')).toEqual({
    kind: 'compileError',
    diagnostics: [
      { row: 2, message: 'CS1038: #endregion ディレクティブが必要です' },
      { row: 5, message: 'CS1027: #endif ディレクティブ が必要です' },
    ],
  });
});

// A property or indexer returning by reference names the variable its getter returns, which assignments, `++`, and
// ref arguments write through; a `ref readonly` one is read-only.
test('properties and indexers returning by reference read and write the variable they return', () => {
  const program = String.raw`class Buffer {
    private int[] items = new int[3];
    private int count = 10;
    public ref int this[int i] => ref items[i];
    public ref int Count { get { return ref count; } }
    public ref readonly int Fixed => ref count;
    public string Show() => string.Join(",", items) + " " + count;
}
class Program {
    static void Inc(ref int x) => x++;
    static void Main() {
        var b = new Buffer();
        b[0] = 5;
        b[0]++;
        b[1] += 3;
        Inc(ref b.Count);
        ref int last = ref b[2];
        last = 7;
        Console.WriteLine(b.Show() + " " + b.Fixed);
    }
}
`;
  expect(executeProgram('csharp', program)).toMatchObject({ kind: 'executed', stdout: '6,3,7 11 11\n' });
  const errors = String.raw`class C {
    int f;
    public ref readonly int A => ref f;
    public ref int B => ref A;
    void M() { A = 1; ref int r = ref A; }
    static void Main() { }
}
`;
  expect(executeProgram('csharp', errors)).toEqual({
    kind: 'compileError',
    diagnostics: [
      {
        row: 3,
        message:
          "CS8333: プロパティ 'A' は読み取り専用の変数であるため、書き込み可能な参照によって返すことはできません",
      },
      {
        row: 4,
        message:
          "CS8331: プロパティ に割り当てることができません。'A' は読み取り専用変数であるため、ref 割り当ての右辺として使用することはできません。",
      },
      {
        row: 4,
        message:
          "CS8329: プロパティ 'A' は、読み取り専用の変数であるため、ref 値または out 値として使用することはできません",
      },
    ],
  });
  expect(
    executeProgram(
      'csharp',
      'class C {\n    int f;\n    public ref int D { get => ref f; set { } }\n    static void Main() { }\n}\n'
    )
  ).toEqual({
    kind: 'compileError',
    diagnostics: [{ row: 2, message: 'CS8147: 参照渡しで返すプロパティは set アクセサーを持つことができません' }],
  });
});

// C# 14 extension blocks declare settable properties, whose setter takes the receiver (by reference for a `ref`
// receiver), and operators of the type they extend; members that need storage or a constructor are errors.
test('extension blocks declare settable properties and operators', () => {
  const program = String.raw`struct Vector {
    public int X, Y;
    public Vector(int x, int y) { X = x; Y = y; }
    public override string ToString() => $"<{X}, {Y}>";
}
class Counter { public int N; }
static class Ext {
    static int created;
    extension(Counter c) { public int Value { get => c.N; set => c.N = value; } }
    extension(Counter) { public static int Created { get => created; set => created = value; } }
    extension(ref Vector v) {
        public int Sum { get => v.X + v.Y; set { v.X = value - v.Y; } }
        public void operator +=(int k) { v.X += k; v.Y += k; }
    }
    extension(Vector) {
        public static Vector operator +(Vector a, Vector b) => new Vector(a.X + b.X, a.Y + b.Y);
        public static bool operator ==(Vector a, Vector b) => a.X == b.X && a.Y == b.Y;
        public static bool operator !=(Vector a, Vector b) => !(a == b);
    }
}
class Program {
    static void Main() {
        var c = new Counter();
        c.Value = 5;
        c.Value++;
        Counter.Created += 2;
        var v = new Vector(1, 2);
        v.Sum = 10;
        v += 1;
        var w = v + new Vector(1, 1);
        w += new Vector(0, 1);
        Console.WriteLine($"{c.N} {Counter.Created} {v} {w} {v == w} {v != w}");
    }
}
`;
  expect(executeProgram('csharp', program)).toMatchObject({
    kind: 'executed',
    stdout: '6 2 <9, 3> <10, 5> False True\n',
  });
  expect(
    executeProgram(
      'csharp',
      'static class Ext {\n    extension(string s) {\n        public int f;\n    }\n}\nclass P { static void Main() { } }\n'
    )
  ).toEqual({
    kind: 'compileError',
    diagnostics: [{ row: 2, message: 'CS9282: このメンバーは拡張ブロックでは使用できません' }],
  });
  expect(
    executeProgram(
      'csharp',
      'static class Ext {\n    extension(string s) {\n        public int Len { init { } get => s.Length; }\n        public static int operator +(int a, int b) => a;\n    }\n}\nclass P { static void Main() { } }\n'
    )
  ).toEqual({
    kind: 'compileError',
    diagnostics: [
      { row: 2, message: "CS9304: 'Ext.extension(string).Len': 拡張ブロックで init のみのアクセサーを宣言できません" },
      { row: 3, message: 'CS9319: 2 項演算子のパラメーターの 1 つは、拡張型である必要があります。' },
    ],
  });
});

// A generic extension block's operators infer the block's type arguments from the operands; extension operators come
// from the namespaces in scope; and a readonly field is a `ref` receiver only in its type's constructor.
test('extension operators infer generic blocks, follow the namespaces in scope, and guard readonly receivers', () => {
  const program = String.raw`using Ops;
var box = new Box<string>("a") + new Box<string>("b");
var pair = new Pair<int, string>(2, "x") * 3;
Console.WriteLine($"{box.Value} {pair.First} {pair.Second} {(-new Box<int>(4)).Value}");
public record Box<T>(T Value);
public record Pair<A, B>(A First, B Second);
namespace Ops
{
    public static class BoxOps
    {
        extension<T>(Box<T>)
        {
            public static Box<T> operator +(Box<T> x, Box<T> y) => new Box<T>((T)(object)($"{x.Value}{y.Value}"));
            public static Box<T> operator -(Box<T> x) => x;
        }
        extension<A, B>(Pair<A, B>)
        { public static Pair<A, B> operator *(Pair<A, B> p, int n) => new Pair<A, B>(p.First, p.Second); }
    }
}
`;
  expect(executeProgram('csharp', program)).toMatchObject({ kind: 'executed', stdout: 'ab 2 x 4\n' });
  expect(executeProgram('csharp', program.replace('using Ops;', ''))).toMatchObject({
    kind: 'compileError',
    diagnostics: [
      {
        row: 1,
        message: "CS0019: 演算子 '+' を 'Box<string>' と 'Box<string>' 型のオペランドに適用することはできません",
      },
      {
        row: 2,
        message: "CS0019: 演算子 '*' を 'Pair<int, string>' と 'int' 型のオペランドに適用することはできません",
      },
      { row: 3, message: "CS0023: 演算子 '-' は 'Box<int>' 型のオペランドに適用できません" },
    ],
  });
  const receiver = String.raw`new Holder().Bump();
public struct S { public int N; }
public class Holder
{ public readonly S Value; public Holder() { Value.Inc(); } public void Bump() => Value.Inc(); }
public static class Ext { extension(ref S s) { public void Inc() { s.N++; } } }
`;
  expect(executeProgram('csharp', receiver)).toMatchObject({
    kind: 'compileError',
    diagnostics: [
      {
        row: 3,
        message:
          'CS0192: 読み取り専用フィールドを ref 値または out 値として使用することはできません (コンストラクターでは可)',
      },
    ],
  });
});

test('syntax and library members beyond the grader are rejected as unavailable', () => {
  expect(executeProgram('csharp', 'var n = 1;\nvar c = new System.Net.Http.HttpClient();\n')).toEqual({
    kind: 'compileError',
    diagnostics: [{ row: 1, message: 'ネットワーク（System.Net）は、この採点環境では使えません。' }],
  });
  expect(executeProgram('csharp', 'new Thread(() => { }).Start();\n')).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 0, message: expect.stringContaining('この採点環境では使えません。') }],
  });
});
