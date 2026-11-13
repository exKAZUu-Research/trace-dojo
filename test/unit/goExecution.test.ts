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

// Go 1.27.3's arm64 rules fuse an addition's second product, unless another such addition in the same function (after
// inlining) makes common subexpression elimination reorder the operands; a subtraction fuses its subtracted product.
test.each([
  ['a sum of two products', '\tfmt.Println(x*x + a*b)', '0.07\n'],
  ['a sum of two products written the other way', '\tfmt.Println(a*b + x*x)', '0.06999999999999999\n'],
  ['two sums of the same products', '\tfmt.Println(x*x + a*b, a*b + x*x)', '0.06999999999999999 0.06999999999999999\n'],
  ['a sum of products in an inlined function', '\tfmt.Println(f(x, a, b))', '0.07\n'],
  ['sums of products in two inlined calls', '\tfmt.Println(f(x, a, b), f(a, x, b))', '0.06999999999999999 0.07\n'],
  [
    'differences and a sum of products',
    '\tfmt.Println(x*x - a*b, a*b - x*x, x*x + a*b, x*x - a*b)',
    '-0.049999999999999996 0.049999999999999996 0.07 -0.049999999999999996\n',
  ],
])('%s fuses the product Go fuses', (_name, body, stdout) => {
  const program = `package main\n\nimport "fmt"\n\nvar v = []float64{0.1, 0.2, 0.3}\n\nfunc f(p, q, r float64) float64 { return p*p + q*r }\n\nfunc main() {\n\tx, a, b := v[0], v[1], v[2]\n${body}\n}\n`;
  expect(executeProgram('go', program)).toMatchObject({ kind: 'executed', uncaughtException: undefined, stdout });
});

test('structs ending in a zero-size field include trailing padding in append capacities', () => {
  const program = `package main

import "fmt"

type empty struct{}
type allZero struct{ a struct{}; b [0]int }
type trailStruct struct{ x int; z struct{} }
type trailArray struct{ x int; z [0]int }
type trailByte struct{ x byte; z struct{} }
type nested struct{ inner trailStruct; b byte }

func main() {
	var a0 []empty; a0 = append(a0, empty{})
	var a1 []allZero; a1 = append(a1, allZero{})
	var a2 []trailStruct; a2 = append(a2, trailStruct{})
	var a3 []trailArray; a3 = append(a3, trailArray{})
	var a4 []trailByte; a4 = append(a4, trailByte{})
	var a5 []nested; a5 = append(a5, nested{})
	var a6 [][2]trailStruct; a6 = append(a6, [2]trailStruct{})
	fmt.Println(cap(a0), cap(a1), cap(a2), cap(a3), cap(a4), cap(a5), cap(a6))
}`;
  expect(executeProgram('go', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: '1 1 2 2 16 1 1\n',
  });
});

// Go 1.27.3's escape analysis, slice optimization pass, and inliner decide whether an append or a []byte conversion
// uses the 32-byte stack buffer, which shows in the capacities.
test.each([
  [
    'a pointer to an element that stays in the function',
    'type P struct{ age int }\n\nfunc (p *P) Older() { p.age++ }',
    '\tvar ps []P\n\tfor i := 0; i < 5; i++ {\n\t\tps = append(ps, P{i})\n\t\tfmt.Print(cap(ps), " ")\n\t}\n\tp := &ps[1]\n\tp.age++\n\tps[2].Older()\n\tfmt.Println(ps[1].age, ps[2].age)',
    '4 4 4 4 8 2 3\n',
  ],
  [
    'a pointer to an element that escapes',
    'var sink *int',
    '\tvar t []int\n\tfor i := 0; i < 5; i++ {\n\t\tt = append(t, i)\n\t\tfmt.Print(cap(t), " ")\n\t}\n\tp := &t[1]\n\tsink = p\n\tfmt.Println(*sink)',
    '1 2 4 4 8 1\n',
  ],
  [
    'a slice returned after appends in a loop',
    'func build(n int) []byte {\n\tvar s []byte\n\tfor i := 0; i < n; i++ {\n\t\ts = append(s, byte(i))\n\t}\n\treturn s\n}',
    '\tx := build(3)\n\ty := build(20)\n\tfmt.Println(cap(x), cap(y))',
    '8 24\n',
  ],
  [
    'a returned slice whose capacity the function reads',
    'func build(n int) []int {\n\tvar s []int\n\tfor i := 0; i < n; i++ {\n\t\ts = append(s, i)\n\t\tfmt.Print(cap(s), " ")\n\t}\n\treturn s\n}',
    '\tfmt.Println(cap(build(5)))',
    '1 2 3 4 8 8\n',
  ],
  [
    'a range over the slice',
    '',
    '\tvar s []int\n\tfor i := 0; i < 3; i++ {\n\t\ts = append(s, i)\n\t\tfmt.Print(cap(s), " ")\n\t}\n\tfor range s {\n\t}\n\tfmt.Println(cap(s))',
    '1 2 3 3\n',
  ],
  [
    'a slice built by an inlined function',
    'func ret3() []int { s := []int{}; s = append(s, 1, 2, 3); return s }\nfunc ret5() []int { s := []int{}; s = append(s, 1, 2, 3, 4, 5); return s }\nfunc bytes3() []byte { s := []byte{}; s = append(s, 1, 2, 3); return s }',
    '\tfmt.Println(cap(ret3()), cap(ret5()), cap(bytes3()))\n\tx := ret3()\n\tfmt.Println(cap(x), x)',
    '4 6 32\n3 [1 2 3]\n',
  ],
  [
    'an inlined function called in a loop',
    'func build(n int) []int {\n\tvar s []int\n\tfor i := 0; i < n; i++ {\n\t\ts = append(s, i)\n\t}\n\treturn s\n}',
    '\tfor n := 1; n <= 3; n++ {\n\t\tfmt.Print(cap(build(n)), " ")\n\t}\n\tfmt.Println(cap(build(3)))',
    '1 2 4 3\n',
  ],
  [
    'a slice passed to functions, stored, and converted to an interface',
    'type H struct{ items []int }\n\nfunc count(s []int) int { return len(s) }',
    '\tvar a, b, c []int\n\tfor i := 0; i < 3; i++ {\n\t\ta = append(a, i)\n\t\tb = append(b, i)\n\t\tc = append(c, i)\n\t\tfmt.Print(cap(a), cap(b), cap(c), " ")\n\t}\n\tvar h H\n\th.items = b\n\tvar x any = c\n\tfmt.Println(count(a), len(h.items), x != nil)',
    '1 1 4 2 2 4 3 3 4 3 3 true\n',
  ],
  [
    'elements of 16, 24, and 40 bytes',
    'type T16 struct{ a, b int }\ntype T24 struct{ a, b, c int }\ntype T40 struct{ a, b, c, d, e int }',
    '\tvar a []T16\n\tvar b []T24\n\tvar c []T40\n\tfor i := 0; i < 3; i++ {\n\t\ta = append(a, T16{})\n\t\tb = append(b, T24{})\n\t\tc = append(c, T40{})\n\t\tfmt.Print(cap(a), cap(b), cap(c), " ")\n\t}\n\tfmt.Println()',
    '2 1 1 2 2 2 4 4 4 \n',
  ],
  [
    'bytes converted from a string',
    'func text(n int) string {\n\ts := ""\n\tfor i := 0; i < n; i++ {\n\t\ts += "a"\n\t}\n\treturn s\n}',
    '\tread := []byte(text(3))\n\twritten := []byte(text(3))\n\twritten[0] = 1\n\tlong := []byte(text(40))\n\tlong[0] = 1\n\tgrown := []byte(text(3))\n\tgrown = append(grown, 1)\n\tshown := []byte(text(3))\n\tfmt.Println(cap(read), cap(written), cap(long), cap(grown), cap(shown), cap([]byte("abc")))\n\tfmt.Println(shown)',
    '3 32 48 32 8 3\n[97 97 97]\n',
  ],
])('the capacity with %s is the one Go reports', (_name, declarations, body, stdout) => {
  const program = `package main\n\nimport "fmt"\n\n${declarations}\n\nfunc main() {\n${body}\n}\n`;
  expect(executeProgram('go', program)).toMatchObject({ kind: 'executed', uncaughtException: undefined, stdout });
});

test('copying and growing slices copy struct and array values without breaking shared pointers', () => {
  const program = `package main

import (
	"fmt"
	"slices"
)

type box struct {
	x int
	a [1]int
	p *int
}

func main() {
	shared := 10
	a := []box{{x: 1, a: [1]int{2}, p: &shared}}
	b := make([]box, 1)
	copy(b, a)
	b[0].x = 9
	b[0].a[0] = 8
	*b[0].p = 20

	c := append(a, box{x: 3})
	c[0].x = 7
	c[0].a[0] = 6

	d := []box{{x: 1}, {x: 2}}
	copy(d[1:], d[:1])
	d[1].x = 5

	ins := slices.Insert(a, 0, box{x: 4})
	ins[1].x = 99
	top := slices.MaxFunc(a, func(u, v box) int { u.x = 77; return u.x - v.x })
	top.x = 88

	arr := [2]box{{x: 1}, {x: 2}}
	var seen []int
	for i, v := range arr {
		if i == 0 {
			arr[1].x = 50
		}
		seen = append(seen, v.x)
	}
	fmt.Println(a[0].x, a[0].a[0], *a[0].p, b[0].x, c[0].x, d[0].x, d[1].x, seen[0], seen[1])
}`;
  expect(executeProgram('go', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: '1 2 20 9 7 1 5 1 2\n',
  });
});

// Go 1.27.3's compiler evaluates an assignment's calls first, then the right side and the destinations' operands, and
// checks each destination at its own store; copies and in-place slice operations write into the existing elements.
test('assignments order their calls, operands, faults, and stores as Go does', () => {
  const program = `package main

import (
	"fmt"
	"slices"
)

type S struct {
	X int
	P *S
}

type K struct{ a, b int }

func rhs() int {
	fmt.Print("rhs ")
	return 9
}

func try(name string, f func()) {
	defer func() { fmt.Println(name, recover() != nil) }()
	f()
}

func main() {
	x := 0
	a := []int{0}
	i := 2
	var p *int
	var s *S
	try("index", func() { x, a[i] = 1, rhs() })
	try("pointer", func() { x, *p = 2, rhs() })
	try("field", func() { x, s.X = 3, rhs() })
	try("container", func() { x, s.P.X = 4, rhs() })
	try("compound", func() { a[i] += rhs() })
	fmt.Println(x)

	b := []int{0, 0}
	j := 0
	moveJ := func() int { j = 1; return 9 }
	b[j] = moveJ()
	c := []int{0}
	old := c
	replaceC := func() int { c = []int{0}; return 9 }
	c[0] = replaceC()
	y := 1
	y += func() int { y = 10; return 1 }()
	mk := map[K]int{}
	key := K{1, 1}
	mk[key] = func() int { key = K{2, 2}; return 9 }()
	fmt.Println(b, old, c, y, mk)

	m := map[int]int{0: 3}
	m[0] += func() int { delete(m, 0); return 2 }()
	n := map[int]int{0: 3}
	n[0] += func() int { clear(n); return 2 }()
	fmt.Println(m, n)

	d := []S{{X: 1}}
	px := &d[0].X
	copy(d, d)
	d[0].X = 5
	e := [][1]int{{2}}
	view := e[0][:]
	copy(e, e)
	e[0][0] = 6
	f := []S{{X: 3}, {X: 4}}
	pf := &f[0].X
	f = slices.Compact(f)
	f = slices.DeleteFunc(f, func(S) bool { return false })
	f = slices.Replace(f, 0, 0)
	f[0].X = 7
	fmt.Println(*px, view[0], *pf)
}`;
  expect(executeProgram('go', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout:
      'rhs index true\nrhs pointer true\nrhs field true\nrhs container true\nrhs compound true\n3\n' +
      '[0 9] [0] [9] 11 map[{1 1}:9]\nmap[0:2] map[0:2]\n5 6 7\n',
  });
});

test('assignments, conversions, generics, defer, map keys, and math match Go semantics', () => {
  const program = String.raw`package main

import (
	"cmp"
	"fmt"
	"math"
	"math/cmplx"
	"strings"
)

const typedInt int = 1
const constMin = min(typedInt, 2)
const c64 complex64 = 1.00000001 + 0i
const realDiff = real(c64) - 1

type Node struct {
	Val  int
	Next *Node
}

type Atom struct {
	str  string
	next *Slist
}
type Slist struct {
	atom Atom
}

type P [2]int
type S struct{ X int }
type Ordered struct{ X, Y, Z int }

type I interface{ M() }
type Embed struct{ I }
type Impl int

func (b Impl) M() { fmt.Print(b, " ") }

func localA() any {
	type T int
	return T(1)
}
func localB() any {
	type T int
	return T(1)
}
func describe[T any](x T) string { return fmt.Sprintf("%v", x) }
func showStructA() string {
	type T int
	return describe(struct{ X T }{1})
}
func showStructB() string {
	type T string
	return describe(struct{ X T }{"hi"})
}
func sumOrdered[T cmp.Ordered](xs []T) T {
	var total T
	for _, x := range xs {
		total += x
	}
	return total
}
func maxOf[T cmp.Ordered](a, b T) T {
	if a > b {
		return a
	}
	return b
}
func fieldOf[T any](x struct{ X T }) T { return x.X }

func shiftUint(i int) uint64 { return 1 << i }

func main() {
	defer println("deferred-err")
	seq := 1
	defer func(v int) { fmt.Print(v) }(seq)
	seq = 2
	defer Embed{Impl(9)}.M()

	mAny := map[any]string{localA(): "a", localB(): "b"}
	nanKey := complex(math.NaN(), 0)
	nanIm := complex(0, math.NaN())
	mCplx := map[complex128]int{nanKey: 1}
	mCplx[nanKey] = 2
	mCplx[nanIm] = 3

	var escaped []int
	for i := 0; i < 5; i++ {
		escaped = append(escaped, i)
	}
	alias := escaped[1:]
	_ = fmt.Sprint(alias)

	a := []int{10, 20}
	idx := 0
	idx, a[idx] = 1, 99
	head := &Node{1, &Node{2, &Node{3, nil}}}
	var prev *Node
	for cur := head; cur != nil; {
		prev, cur, cur.Next = cur, cur.Next, prev
	}

	var nilSlice []int
	zeroArr := [0]int(nilSlice)
	bigSlice := make([]int, 200000)

	var nilPtr *int
	var boxedNil any = nilPtr
	gotPtr, ptrOk := boxedNil.(*int)

	holder := S{X: 1}
	px := &holder.X
	holder = S{X: 2}
	seenViaPtr := *px
	*px = 3

	arrBacking := [2]int{1, 2}
	view := arrBacking[:]
	arrBacking = [2]int{8, 9}

	sw := ""
	switch 0.5 {
	case 0.5:
		sw += "f"
	case 1.5:
		sw += "g"
	}
	switch 1i {
	case 1i:
		sw += "c"
	case 2i:
		sw += "d"
	}

	var mask uint32
	sh := 3
	mask |= 1 << sh
	var u8 uint8 = 1 << sh

	neg := -5.0
	two32 := float64(1 << 32)
	bytes := []byte("hello")
	bytesCap0 := cap(bytes)
	bytes = append(bytes, '!')
	runesConst := []rune("héllo")
	runesDyn := []rune(strings.Repeat("a", 5))

	var orderLog string
	record := func(tag string, v int) int {
		orderLog += tag
		return v
	}
	ord := Ordered{Z: record("z", 3), X: record("x", 1), Y: record("y", 2)}

	var iNil I
	panickedAtDefer := false
	func() {
		defer func() { panickedAtDefer = recover() != nil }()
		defer iNil.M()
		orderLog += "unreachable"
	}()

	fmt.Println(
		len(mAny), mAny[localA()], mAny[localB()],
		len(mCplx), mCplx[nanKey],
		cap(escaped),
		a[0], prev.Val, len(zeroArr), len(bigSlice),
		gotPtr == nil && ptrOk,
		seenViaPtr, holder.X, view[0], view[1],
		sw,
		constMin, realDiff,
		showStructA(), showStructB(),
		sumOrdered([]int{1, 2, 3}), sumOrdered([]string{"a", "b"}),
		maxOf(3, 2.5), maxOf(1, 'a'), fieldOf(struct{ X int }{7}),
		mask, u8, shiftUint(sh),
		Slist{Atom{str: "ok"}}.atom.str,
		P{1, 2} == [2]int{1, 2}, S{0} == struct{ X int }{0},
		uint32(neg), uint32(two32),
		bytesCap0, cap(bytes), cap(runesConst), cap(runesDyn),
		orderLog, ord.X, panickedAtDefer,
		math.Remainder(1e20, 3), math.Remainder(0.3, 0.1),
		math.Float64bits(math.FMA(math.SmallestNonzeroFloat64, 0.5, math.SmallestNonzeroFloat64)),
		cmplx.Sqrt(complex(1, math.NaN())),
	)
}`;
  expect(executeProgram('go', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout:
      '2 a b 3 0 8 99 3 0 200000 true 2 3 8 9 fc 1 0 {1} {hi} 6 ab 3 97 7 8 8 8 ok true true 4294967291 0 5 16 5 32 zxy 1 true 1 -2.7755575615628914e-17 2 (NaN+NaNi)\n9 1',
    stderr: 'deferred-err\n',
  });
});

test('standard library zero values, nil receivers, streaming UTF-8, limits, and capacities match Go', () => {
  const program = String.raw`package main

import (
	"bufio"
	"errors"
	"fmt"
	"image/color"
	"io"
	"maps"
	"os"
	"slices"
	"strings"
	"time"
	"unicode/utf8"
)

var unwrapCalls int

type customErr int

func (customErr) Error() string { return "e" }
func (customErr) Unwrap() error {
	unwrapCalls++
	return nil
}

type shortWriter int

func (shortWriter) Write(p []byte) (int, error) { return 1, nil }

func nilReceiverPanics() (rOk, wOk bool) {
	func() {
		defer func() { rOk = recover() != nil }()
		var r *strings.Reader
		_ = r.Len()
	}()
	func() {
		defer func() { wOk = recover() != nil }()
		var w *bufio.Writer
		_ = w.Buffered()
	}()
	return rOk, wOk
}

func main() {
	var b strings.Builder
	b.Grow(100)
	b.WriteString("abc")

	var zeroReader strings.Reader
	_, zeroEOF := zeroReader.ReadByte()
	origReader := strings.NewReader("abc")
	copiedReader := *origReader
	_, _ = origReader.ReadByte()

	scanner := bufio.NewScanner(strings.NewReader(strings.Repeat("a", 70000)))
	scanOk := scanner.Scan()
	scanErr := scanner.Err()
	smallScanner := bufio.NewScanner(strings.NewReader("01234567890"))
	smallScanner.Buffer(nil, 10)
	smallOk := smallScanner.Scan()

	rgba := color.RGBAModel.Convert(&color.Gray{Y: 100})
	var zeroTime time.Time
	_ = errors.Unwrap(customErr(1))
	copiedBytes, copyErr := io.Copy(shortWriter(0), strings.NewReader("abc"))
	rNil, wNil := nilReceiverPanics()

	s := []int{5, 1, 4, 2, 3}
	m := map[string]int{"a": 1, "b": 2, "c": 3}

	fmt.Print("\xc3")
	fmt.Print("\xa9 ")
	_, _ = os.Stderr.Write([]byte{230})
	_, _ = os.Stderr.Write([]byte{151, 165})

	fmt.Println(
		b.Len(), b.Cap(),
		strings.EqualFold("ı", "i"), strings.EqualFold("ſ", "S"),
		zeroEOF, origReader.Len(), copiedReader.Len(),
		scanOk, scanErr, smallOk,
		rgba,
		zeroTime.Year(), zeroTime.IsZero(),
		unwrapCalls,
		copiedBytes, copyErr,
		utf8.FullRuneInString("\xff"), utf8.FullRuneInString("\xc2A"), utf8.FullRuneInString("\xc2"),
		cap(slices.Clone(s)), len(maps.Clone(m)), cap(strings.SplitN("a,b,c", ",", 5)),
		rNil, wNil,
	)
}`;
  expect(executeProgram('go', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout:
      'é 3 112 false true EOF 2 3 false bufio.Scanner: token too long false {100 100 100 255} 1 true 1 1 short write true true false 6 3 5 true true\n',
    stderr: '日',
  });
});

test.each([
  ['untyped bool assigned to int', 'package main\nfunc main() { x := 1; var n int = x == 1; _ = n }', 2],
  ['string index in const', 'package main\nfunc main() { const c = "abc"[0]; _ = c }', 2],
  ['mismatched untyped families', 'package main\nfunc main() { _ = "a" + 1 }', 2],
  [
    'excess struct literal value without false unused error',
    'package main\ntype T struct{ x int }\nfunc main() {\n\ta := 1\n\tb := 2\n\tt := T{a, b}\n\t_ = t\n}',
    6,
  ],
  ['method without body', 'package main\ntype T struct{}\nfunc (t *T) M()\nfunc main() {}', 3],
  ['typed const mismatch', 'package main\nconst x int = 1\nconst y float64 = x\nfunc main() {}', 3],
  ['fractional typed float const to int', 'package main\nconst x float64 = 1.2\nfunc main() { _ = int(x) }', 3],
  [
    'constant returned as unconstrained type param',
    'package main\nfunc f[T any](x T) T { return 1 }\nfunc main() { _ = f("a") }',
    2,
  ],
  [
    'duplicate type-switch case',
    'package main\nfunc main() { var a any = 1; switch a.(type) { case int: ; case int: } }',
    2,
  ],
  ['expanding generic instantiation cycle', 'package main\nfunc f[T any](x T) { f([]T{x}) }\nfunc main() { f(0) }', 2],
  [
    'instantiation cycle through two functions',
    'package main\nfunc f[T any](x T) { g(x) }\n\nfunc g[T any](x T) { f(&x) }\nfunc main() { f(0) }',
    4,
  ],
  [
    'impossible type-switch case',
    'package main\ntype I interface{ M() }\nfunc main() { var i I; switch i.(type) { case int: } }',
    3,
  ],
  [
    'missing return after a local named panic',
    'package main\nfunc f() int {\n\tpanic := func(int) {}\n\tpanic(1)\n}\nfunc main() { f() }',
    5,
  ],
  [
    'untyped constant operand of a type parameter',
    'package main\nimport "cmp"\nfunc f[T cmp.Ordered](a T) bool { return a < 1 }\nfunc main() { f(1) }',
    3,
  ],
  [
    'ambiguous diamond selector',
    'package main\ntype A struct{ X int }\ntype B struct{ A }\ntype C struct{ A }\ntype D struct{ B; C }\nfunc main() { var d D; _ = d.X }',
    6,
  ],
])('%s is rejected at compile time', (_name, program, line) => {
  const execution = executeProgram('go', program);
  expect(execution).toMatchObject({ kind: 'compileError' });
  if (execution.kind === 'compileError') expect(execution.diagnostics[0].row + 1).toBe(line);
});

test.each([
  ['nested zero-value array exceeding maxSlots', 'package main\nfunc main() { var a [1001][1001]int; _ = a }'],
  [
    'strings.ReplaceAll exceeding maxStringLength',
    'package main\nimport "strings"\nfunc main() { a := strings.Repeat("a", 2000); b := strings.Repeat("b", 2000); _ = strings.ReplaceAll(a, "a", b) }',
  ],
  [
    'slices.Repeat exceeding maxSlots',
    'package main\nimport "slices"\nfunc main() { _ = slices.Repeat([]int{1}, 1000000000) }',
  ],
])('%s stops within runtime memory limits', (_name, program) => {
  const execution = executeProgram('go', program);
  expect(execution).toMatchObject({
    kind: 'executed',
    uncaughtException: expect.stringContaining('out of memory'),
  });
});

// Go 1.27.3 prints these lines: output keeps a leading byte order mark even when written a byte at a time; Scanner and
// Writer keep their buffers in Go slices, so a buffer given to Scanner.Buffer receives the input and a copied Writer
// shares its backing array; case mappings and folds follow Go's Unicode tables; reading from strings with fmt's and
// bufio's readers works; and Builder and Reader print their fields.
test('library state, folding, scanning, and output bytes match Go', () => {
  const program = String.raw`package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"
	"unicode"
)

func main() {
	fmt.Print("\xef\xbb\xbf")
	os.Stdout.Write([]byte{239})
	os.Stdout.Write([]byte{187, 191})
	fmt.Fprint(os.Stderr, "\xef\xbb\xbfe")

	b := make([]byte, 10)
	s := bufio.NewScanner(strings.NewReader("abc\nde"))
	s.Buffer(b, 10)
	s.Scan()
	fmt.Println(string(b[:3]), &s.Bytes()[0] == &b[0])
	s.Scan()
	fmt.Println(&s.Bytes()[0] == &b[4])

	var out strings.Builder
	w := bufio.NewWriterSize(&out, 10)
	w.WriteString("a")
	c := *w
	w.WriteString("b")
	c.WriteString("c")
	w.Flush()
	c.Flush()
	w.WriteString("xy")
	d := *w
	d.WriteString("Z")
	d.Flush()
	w.Flush()
	fmt.Println(out.String())

	fmt.Println(unicode.SimpleFold(223), unicode.SimpleFold(304), unicode.SimpleFold(305), unicode.SimpleFold(452),
		unicode.SimpleFold(8064), unicode.ToUpper(8064), unicode.ToTitle(453), unicode.ToLower(7838),
		strings.EqualFold("ᾀ", "ᾈ"), strings.EqualFold("ᾳ", "ᾼ"), strings.EqualFold("ß", "ẞ"), strings.EqualFold("İ", "i"),
		strings.ToUpper("ᾀß"))

	var x, y int
	n, err := fmt.Sscanf("10 20", "%d %d", &x, &y)
	fmt.Println(n, err, x, y)
	var word string
	n, err = fmt.Sscan("hello\n 5", &word, &x)
	fmt.Println(n, err, word, x)
	n, err = fmt.Sscanln("7\n8", &x, &y)
	fmt.Println(n, err, x)
	n, err = fmt.Sscanf("x", "%d", &x)
	fmt.Println(n, err)
	line, err := bufio.NewReader(strings.NewReader("first\nsecond")).ReadString('\n')
	fmt.Printf("%q %v\n", line, err)

	var zero strings.Builder
	fmt.Println(strings.NewReader("abc"), zero)
}`;
  expect(executeProgram('go', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: `\uFEFF\uFEFFabc true
true
acacxyZxy
7838 304 305 453 8072 8072 453 223 true true true false ᾈß
2 <nil> 10 20
2 <nil> hello 5
1 unexpected newline 7
0 expected integer
"first\\n" <nil>
&{abc 0 -1} {<nil> []}
`,
    stderr: '\uFEFFe',
  });
});

test.each([
  [
    'a Replacer whose patterns fail at every position',
    `_ = strings.NewReplacer(${Array.from({ length: 500 }, (_, i) => `"z${i}", "x"`).join(', ')}).Replace(strings.Repeat("a", 1000000))`,
  ],
  [
    'a Replacer whose long pattern fails late',
    '_ = strings.NewReplacer(strings.Repeat("a", 5000)+"b", "x").Replace(strings.Repeat("a", 1000000))',
  ],
  [
    'repeated searches of a long string',
    's := strings.Repeat("a", 1000000)\n\tfor i := 0; i < 100000; i++ {\n\t\t_ = strings.Contains(s, "b")\n\t}',
  ],
])('%s stops at the operation limit', (_name, body) => {
  const program = `package main\n\nimport "strings"\n\nfunc main() {\n\t${body}\n}`;
  expect(executeProgram('go', program)).toEqual({ kind: 'limitExceeded', limit: 'operations' });
});

// Go 1.27.3 on arm64 prints these with TZ=UTC: time's calendar arithmetic, layouts, and parsing; math/rand's reseeded
// generator, ziggurat draws, and Zipf; math/rand/v2's ChaCha8; and the bits of math's special functions. Sleep returns
// at once but moves the clock that Since reads.
test('time, math/rand, and math special functions compute what Go computes', () => {
  const program = String.raw`package main

import (
	"fmt"
	"math"
	"math/rand"
	v2 "math/rand/v2"
	"time"
)

func main() {
	t := time.Date(2024, time.February, 29, 23, 59, 58, 999999999, time.FixedZone("JST", 9*60*60))
	u := t.Add(90*time.Minute + 2*time.Second).AddDate(0, 12, 0)
	fmt.Println(t, u.UTC(), u.Sub(t), u.Weekday(), u.YearDay(), u.Unix())
	fmt.Println(t.Format(time.RFC1123Z), t.Format("Mon Jan _2 3:04:05.000 PM 2006 MST"), t.Truncate(time.Hour), t.Round(time.Second))
	p, err := time.Parse(time.RFC3339, "2006-01-02T15:04:05.5+07:00")
	fmt.Println(p, err, p.Location())
	_, err = time.Parse(time.DateOnly, "2023-02-29")
	fmt.Println(err)
	d, _ := time.ParseDuration("1h15m30.918273645s")
	fmt.Println(d, d.Round(time.Millisecond), d.Truncate(time.Minute), d.Minutes(), time.Duration(1500)*time.Microsecond)
	start := time.Now()
	time.Sleep(time.Hour)
	fmt.Println(time.Since(start) >= time.Hour)

	r := rand.New(rand.NewSource(1))
	r.Seed(7)
	fmt.Println(r.Intn(100), r.Intn(100), math.Float64bits(r.NormFloat64()), math.Float64bits(r.ExpFloat64()))
	z := rand.NewZipf(r, 1.5, 2, 1000)
	fmt.Println(z.Uint64(), z.Uint64(), z.Uint64())
	var seed [32]byte
	c := v2.New(v2.NewChaCha8(seed))
	fmt.Println(c.Uint64(), c.IntN(1000), math.Float64bits(c.NormFloat64()))

	fmt.Println(math.Float64bits(math.Gamma(4.7)), math.Float64bits(math.Erf(0.3)), math.Float64bits(math.J0(2.5)), math.Float64bits(math.Yn(3, 7.1)))
	lg, sign := math.Lgamma(-2.5)
	fmt.Println(math.Float64bits(lg), sign, math.Float64bits(math.Erfinv(0.9)), math.Float64bits(math.Cbrt(10)))
}`;
  expect(executeProgram('go', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout:
      '2024-02-29 23:59:58.999999999 +0900 JST 2025-02-28 16:30:00.999999999 +0000 UTC 8761h30m2s Saturday 60 1740760200\nThu, 29 Feb 2024 23:59:58 +0900 Thu Feb 29 11:59:58.999 PM 2024 JST 2024-02-29 23:00:00 +0900 JST 2024-02-29 23:59:59 +0900 JST\n2006-01-02 15:04:05.5 +0700 +0700 <nil> \nparsing time "2023-02-29": day out of range\n1h15m30.918273645s 1h15m30.918s 1h15m0s 75.51530456075 1.5ms\ntrue\n86 70 4606516669249208593 4609484862093197509\n1 45 9\n12432809566553409497 421 13835421274913171332\n4624876730496230199 4599591633323682319 13810505694936104767 4598160665187177521\n13811638431671717664 -1 4607916898044544591 4612033774433628239\n',
  });
});

// Go 1.27.3 prints these: Go by Example's regexp calls, named groups and templates, Split, simple case folding, Unicode
// classes and \b, leftmost-first versus POSIX leftmost-longest, byte offsets over invalid UTF-8, and parse errors.
test('regexp matches as the RE2 engine of Go does', () => {
  const program = String.raw`package main

import (
	"bytes"
	"fmt"
	"regexp"
	"strings"
)

func main() {
	r := regexp.MustCompile("p([a-z]+)ch")
	fmt.Println(r, r.MatchString("peach"), r.FindStringIndex("peach punch"), r.FindStringSubmatch("peach punch"))
	fmt.Println(r.FindAllStringSubmatchIndex("peach punch pinch", -1), r.FindAllString("peach punch pinch", 2))
	fmt.Println(r.ReplaceAllString("a peach", "<$1>"), string(r.ReplaceAllFunc([]byte("a peach"), bytes.ToUpper)))
	re := regexp.MustCompile("(?P<first>\\w+)\\s(?P<last>\\w+)")
	fmt.Printf("%q %d\n", re.SubexpNames(), re.SubexpIndex("last"))
	fmt.Println(re.ReplaceAllString("ada lovelace, alan turing", "${'$'}{last}_$first"))
	fmt.Printf("%q %q\n", regexp.MustCompile("a*").Split("baaaab", -1), regexp.MustCompile(",\\s*").Split("x, y,z", 2))
	fmt.Println(regexp.MustCompile("(?i)straße|k").FindAllString("STRASSE Straſſe STRAßE K", -1))
	fmt.Println(regexp.MustCompile("\\p{Greek}+|\\bgo\\b").FindAllStringIndex("αβγ go gopher", -1))
	fmt.Println(regexp.MustCompile("a(|b)").FindString("ab"), regexp.MustCompilePOSIX("a(|b)").FindString("ab"))
	pre, complete := regexp.MustCompile("^hello(?:x|y)").LiteralPrefix()
	fmt.Println(pre, complete, regexp.MustCompile(".").FindAllStringIndex("é\xffz", -1))
	fmt.Println(regexp.QuoteMeta("1+1=2? [yes]"), regexp.MustCompile("b+").MatchReader(strings.NewReader("abbc")))
	for _, p := range []string{"a(b", "x**", "[z-a]", "\\pX", "a{1001}", "(?P<>x)"} {
		_, err := regexp.Compile(p)
		fmt.Println(err)
	}
	defer func() { fmt.Println(recover()) }()
	regexp.MustCompile("a)")
}`;
  expect(executeProgram('go', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout:
      'p([a-z]+)ch true [0 5] [peach ea]\n' +
      '[[0 5 1 3] [6 11 7 9] [12 17 13 15]] [peach punch]\n' +
      'a <ea> a PEACH\n' +
      '["" "first" "last"] 2\n' +
      'lovelace_ada, turing_alan\n' +
      '["b" "b"] ["x" "y,z"]\n' +
      '[STRA\u00DFE \u212A]\n' +
      '[[0 6] [7 9]]\n' +
      'a ab\n' +
      'hello false [[0 2] [2 3] [3 4]]\n' +
      '1\\+1=2\\? \\[yes\\] true\n' +
      'error parsing regexp: missing closing ): `a(b`\n' +
      'error parsing regexp: invalid nested repetition operator: `**`\n' +
      'error parsing regexp: invalid character class range: `z-a`\n' +
      'error parsing regexp: invalid character class range: `\\pX`\n' +
      'error parsing regexp: invalid repeat count: `{1001}`\n' +
      'error parsing regexp: invalid named capture: `(?P<>`\n' +
      'regexp: Compile(`a)`): error parsing regexp: unexpected ): `a)`\n',
  });
});

test('a run that changes library variables leaves the next run unaffected', () => {
  const changing = `package main
import ("fmt"; "os"; "time"; "unicode")
func main() {
	*os.Stdout = *os.Stderr
	*time.UTC = *time.FixedZone("X", 3600)
	*unicode.Upper = unicode.RangeTable{}
	fmt.Fprintln(os.Stdout, time.UTC, unicode.Is(unicode.Upper, 'A'))
}`;
  expect(executeProgram('go', changing)).toMatchObject({ stdout: '', stderr: 'X false\n' });
  const reading = `package main
import ("fmt"; "os"; "time"; "unicode")
func main() { fmt.Fprintln(os.Stdout, time.UTC, unicode.Is(unicode.Upper, 'A')) }`;
  expect(executeProgram('go', reading)).toMatchObject({ stdout: 'UTC true\n', stderr: '' });
});

test.each([
  [
    'list elements',
    'package main\nimport "container/list"\nfunc main() { l := list.New(); l.PushBack(1); for i := 0; i < 18; i++ { l.PushBackList(l) } }',
  ],
  [
    'a huge float precision',
    'package main\nimport "strconv"\nfunc main() { _ = strconv.FormatFloat(1, \'f\', 1<<30, 64) }',
  ],
])('a library call that allocates past the limits stops the run: %s', (_, program) => {
  expect(executeProgram('go', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: expect.stringContaining('out of memory'),
  });
});

test.each([
  ['math.Jn of a huge order', 'package main\nimport "math"\nfunc main() { _ = math.Jn(9223372036854775807, 1) }'],
  [
    'strconv.ParseFloat of a long number',
    'package main\nimport ("strconv"; "strings")\nfunc main() { for i := 0; i < 100; i++ { _, _ = strconv.ParseFloat(strings.Repeat("9", 500000), 64) } }',
  ],
])('a library loop proportional to its argument spends operations: %s', (_, program) => {
  expect(executeProgram('go', program)).toEqual({ kind: 'limitExceeded', limit: 'operations' });
});

// Go 1.27.3 prints these: text/template's actions, functions, nested templates, options, and its parse and execution
// errors, which name the failing action.
test('text/template executes templates as Go does', () => {
  const program = String.raw`package main

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"text/template"
)

type Item struct {
	Name  string
	Price float64
	Tags  []string
}

func (i Item) Label() string { return strings.ToUpper(i.Name) }

func show(t *template.Template, data any) {
	err := t.Execute(os.Stdout, data)
	fmt.Println("|", err)
}

func main() {
	funcs := template.FuncMap{
		"join": strings.Join,
		"half": func(x float64) (float64, error) {
			if x < 0 {
				return 0, errors.New("negative")
			}
			return x / 2, nil
		},
	}
	t := template.Must(template.New("item").Funcs(funcs).Parse(
		"{{define \"tags\"}}[{{join . \",\"}}]{{end}}{{.Label}} {{printf \"%.2f\" .Price}} {{half .Price}} {{template \"tags\" .Tags}}" +
			"{{range $i, $t := .Tags}}{{if eq $t \"skip\"}}{{continue}}{{end}} {{$i}}:{{$t}}{{end}}"))
	show(t, Item{"pen", 1.5, []string{"a", "skip", "b"}})
	show(t, &Item{"ink", -3, nil})
	m := template.Must(template.New("m").Option("missingkey=error").Parse("{{range $k, $v := .}}{{$k}}={{$v}} {{end}}{{.zz}}"))
	show(m, map[string]int{"b": 2, "a": 1})
	show(template.Must(template.New("r").Parse("{{range 5}}{{if eq . 3}}{{break}}{{end}}{{.}}{{end}} {{.Missing}}")), Item{})
	_, err := template.New("bad").Parse("{{if .X}}{{.Y}")
	fmt.Println(err)
	fmt.Println(template.HTMLEscapeString("<a href=\"x\">"), template.JSEscapeString("it's"))
}`;
  expect(executeProgram('go', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout:
      'PEN 1.50 0.75 [a,skip,b] 0:a 2:b| <nil>\nINK -3.00 | template: item:1:78: executing "item" at <half .Price>: error calling half: negative\na=1 b=2 | template: m:1:44: executing "m" at <.zz>: map has no entry for key "zz"\n012 | template: r:1:55: executing "r" at <.Missing>: can\'t evaluate field Missing in type main.Item\ntemplate: bad:1: bad character U+007D \'}\'\n&lt;a href=&#34;x&#34;&gt; it\\\'s\n',
  });
});
