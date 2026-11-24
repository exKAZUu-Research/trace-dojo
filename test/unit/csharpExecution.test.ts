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

test('syntax and library members beyond the grader are rejected as unavailable', () => {
  expect(executeProgram('csharp', 'int[] a = { 1, 2 };\nConsole.WriteLine(a[^1]);\n')).toEqual({
    kind: 'compileError',
    diagnostics: [{ row: 1, message: '末尾からの添字（`^`）は、この採点環境では使えません。' }],
  });
  expect(executeProgram('csharp', 'Console.WriteLine(Console.ReadLine());\n')).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 0, message: expect.stringContaining('この採点環境では使えません。') }],
  });
});
