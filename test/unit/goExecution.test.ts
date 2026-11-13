import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test('a program that draws reports its final board and the turtles still reachable', () => {
  const execution = executeProgram(
    'go',
    `package main

func draw() {
	temporary := NewTurtle(4, 4, "Y")
	temporary.Forward()
}

func main() {
	keep := NewTurtle(1, 1, "G")
	draw()
	keep.右を向く()
	keep.前に進む()
}`
  );
  expect(execution).toEqual({
    kind: 'executed',
    finalBoard: ['.......', '.GG....', '.......', '.......', '....Y..', '....Y..', '.......'].join('\n'),
    finalTurtles: [{ x: 2, y: 1, color: 'G', dir: 'E' }],
    uncaughtException: undefined,
    stdout: '',
    stderr: '',
    finalFiles: {},
  });
});

// Go 1.27.3 prints the builtins' floats as fmt's %v does, and writes them and os.Stderr to standard error.
test('println and os.Stderr write to standard error', () => {
  const program = `package main

import (
	"fmt"
	"os"
)

func main() {
	println("n", 42, 3.5, 1e100, true)
	print("a", 1.0, "\\n")
	fmt.Fprintln(os.Stderr, "err")
	fmt.Println("out")
}`;
  expect(executeProgram('go', program)).toMatchObject({
    kind: 'executed',
    stdout: 'out\n',
    stderr: 'n 42 3.5 1e+100 true\na1\nerr\n',
  });
});

// Go 1.27.3 on arm64 prints the expected values: shortest float formatting with %v's exponent rule, a Newton step whose
// z*z - x Go's compiler fuses into one rounding, append's capacity for a slice that does not escape, pdqsort's order of
// equal elements, and math/rand's seeded sequence.
test('values print as Go prints them', () => {
  const program = String.raw`package main

import (
	"fmt"
	"math/rand"
	"sort"
	"strconv"
)

type point struct {
	X, Y int
}

type item struct {
	name string
	rank int
}

func root(x float64) float64 {
	z := 1.0
	for i := 0; i < 10; i++ {
		z -= (z*z - x) / (2 * z)
	}
	return z
}

func main() {
	var grown []int
	grown = append(grown, 1)
	var shown []int
	shown = append(shown, 1)
	fmt.Sprint(shown)
	items := []item{{"a", 2}, {"b", 1}, {"c", 2}, {"d", 1}, {"e", 2}, {"f", 1}, {"g", 2}, {"h", 1}, {"i", 2}, {"j", 1}, {"k", 2}, {"l", 1}, {"m", 2}, {"n", 1}}
	sort.Slice(items, func(i, j int) bool { return items[i].rank < items[j].rank })
	order := ""
	for _, it := range items {
		order += it.name
	}
	_, err := strconv.Atoi("12a")
	r := rand.New(rand.NewSource(42))
	actual := []string{
		fmt.Sprint(1e20, 123456789.0, 0.0001, 1e-5, float32(0.1)),
		fmt.Sprint(root(2)),
		fmt.Sprint(map[string]int{"b": 2, "a": 1}, &point{1, 2}),
		fmt.Sprintf("%+v %#v %T %q %x %8.3f|%-5d|", point{1, 2}, point{1, 2}, &point{}, "日本", 255, 3.14159, 42),
		fmt.Sprint(cap(grown), cap(shown)),
		order,
		fmt.Sprint(err),
		fmt.Sprint(r.Intn(100), r.Intn(100), r.Float64()),
	}
	expected := []string{
		"1e+20 1.23456789e+08 0.0001 1e-05 0.1",
		"1.4142135623730951",
		"map[a:1 b:2] &{1 2}",
		"{X:1 Y:2} main.point{X:1, Y:2} *main.point \"日本\" ff    3.142|42   |",
		"4 1",
		"jbndhflmgakiec",
		"strconv.Atoi: parsing \"12a\": invalid syntax",
		"5 87 0.604093851558642",
	}
	for i, a := range actual {
		if expected[i] != "" && a != expected[i] {
			panic(a + " != " + expected[i])
		}
	}
}
`;
  expect(executeProgram('go', program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
});

const goMain = (body: string): string => `package main

import "fmt"

func main() {
\tfmt.Print()
${body}
}`;

test.each([
  [
    'an index out of range',
    '\ts := []int{1, 2, 3}\n\ti := 5\n\tfmt.Println(s[i])',
    'panic: runtime error: index out of range [5] with length 3',
  ],
  ['a write to a nil map', '\tvar m map[string]int\n\tm["a"] = 1', 'panic: assignment to entry in nil map'],
  [
    'a nil pointer',
    '\tvar p *struct{ x int }\n\tfmt.Println(p.x)',
    'panic: runtime error: invalid memory address or nil pointer dereference',
  ],
  [
    'a failed type assertion',
    '\tvar v any = "s"\n\tfmt.Println(v.(int))',
    'panic: interface conversion: interface {} is string, not int',
  ],
  [
    'a panic in a deferred call after recovering',
    '\tdefer func() {\n\t\tr := recover()\n\t\tpanic(fmt.Sprintf("again: %v", r))\n\t}()\n\tpanic("first")',
    'panic: first [recovered]\n\tpanic: again: first',
  ],
])("%s ends the program with Go's panic message", (_name, body, message) => {
  expect(executeProgram('go', goMain(body))).toMatchObject({ kind: 'executed', uncaughtException: message });
});

// Go 1.27.3 reports these errors at these 1-based lines.
test.each([
  ['an unused variable', 'package main\n\nfunc main() {\n\tx := 1\n}', 4],
  [
    'a missing return',
    'package main\n\nfunc f(x int) int {\n\tif x > 0 {\n\t\treturn 1\n\t}\n}\n\nfunc main() {\n\tf(1)\n}',
    7,
  ],
  ['a type mismatch', 'package main\n\nfunc main() {\n\tvar s string = 1\n\t_ = s\n}', 4],
  ['an untyped constant that overflows', 'package main\n\nfunc main() {\n\tvar b byte = 256\n\t_ = b\n}', 4],
  ['an unused import', 'package main\n\nimport "strings"\n\nfunc main() {}', 3],
])('%s is a compile error where Go reports it', (_name, program, line) => {
  const execution = executeProgram('go', program);
  expect(execution).toMatchObject({ kind: 'compileError' });
  if (execution.kind === 'compileError') expect(execution.diagnostics[0].row + 1).toBe(line);
});

test('a declaration may declare several names at once', () => {
  const program =
    'package main\n\nimport "fmt"\n\nconst x, y = 1, 2\n\nfunc main() {\n\tvar a, b int = 3, 4\n\tfmt.Println(x, y, a, b)\n}';
  expect(executeProgram('go', program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
});

test('the phase of a complex number rounds as Go computes it', () => {
  const program =
    'package main\n\nimport (\n\t"fmt"\n\t"math/cmplx"\n)\n\nfunc main() {\n\tif s := fmt.Sprint(cmplx.Phase(0.1 + 0.7i)); s != "1.4288992721907325" {\n\t\tpanic(s)\n\t}\n}';
  expect(executeProgram('go', program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
});

test('formatting with a bit size of 32 rounds the value to a float32 first', () => {
  const program =
    'package main\n\nimport "strconv"\n\nfunc main() {\n\tif s := strconv.FormatFloat(3.14159265358979, \'g\', -1, 32); s != "3.1415927" {\n\t\tpanic(s)\n\t}\n}';
  expect(executeProgram('go', program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
});

test('a value method called through a nil pointer panics', () => {
  const program =
    'package main\n\nimport "fmt"\n\ntype T float64\n\nfunc (t T) String() string { return "t" }\n\nfunc main() {\n\tvar p *T\n\tif s := fmt.Sprint(p); s != "<nil>" {\n\t\tpanic(s)\n\t}\n\tp.String()\n}';
  expect(executeProgram('go', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: expect.stringContaining('nil pointer dereference'),
  });
});

test('a wrong verb prints its value with the width and precision written', () => {
  const program = goMain(
    '\tif s := fmt.Sprintf("|%[3]*.[2]*[1]f|", 12, 2, 6); s != "|%!f(int=    12)|" {\n\t\tpanic(s)\n\t}'
  );
  expect(executeProgram('go', program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
});

test('syntax of later stages is rejected as unavailable', () => {
  const execution = executeProgram('go', goMain('\tch := make(chan int)\n\tfmt.Println(ch)'));
  expect(execution).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ message: 'チャネルは、この採点環境では使えません。' }],
  });
});

test('an endless loop stops at the operation limit', () => {
  expect(executeProgram('go', goMain('\tfor {\n\t}'))).toEqual({ kind: 'limitExceeded', limit: 'operations' });
});

// Go 1.27.3 on arm64 fuses a multiplication into the addition that uses it, also through a variable defined once,
// unless both factors are constants, which its compiler multiplies before the program runs.
test('floating-point multiply-adds round as Go fuses them', () => {
  const program = String.raw`package main

import "fmt"

func calc(a, b float64) string {
	p := a * b
	sum := 0.3
	sum += a * b
	x := 1.1
	y := 1.1
	y = 2.2
	c := 3.0 / 7
	d := c * 1.1
	return fmt.Sprint(p+0.3, sum, a*x+0.3, a*y+0.3, d+0.3)
}

func main() {
	got := calc([]float64{3.0 / 7}[0], 1.1)
	want := "0.7714285714285715 0.7714285714285715 0.7714285714285715 1.2428571428571429 0.7714285714285714"
	if got != want {
		panic(got)
	}
}`;
  expect(executeProgram('go', program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
});
