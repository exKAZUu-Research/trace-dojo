package main

import (
	"fmt"
	"strings"
)

type Number interface {
	~int | ~float64
}

type MyInt int

func Sum[T Number](xs ...T) T {
	var s T
	for _, x := range xs {
		s += x
	}
	return s
}

type Stringer interface{ String() string }
type Named interface {
	Stringer
	Name() string
}

type P struct {
	N string `json:"n"`
}

func (p P) String() string { return "P(" + p.N + ")" }
func (p P) Name() string   { return p.N }

type Alias = P
type Celsius = float64

func join(sep string, parts ...string) string { return strings.Join(parts, sep) }

func Map[T, U any](xs []T, f func(T) U) []U {
	var out []U
	for _, x := range xs {
		out = append(out, f(x))
	}
	return out
}

func main() {
	fmt.Println(Sum(1, 2, 3), Sum(1.5, 2), Sum[MyInt](1, 2), Sum[int]())
	nums := []int{4, 5}
	fmt.Println(Sum(nums...), join("-", "a", "b"), join(","), join("+", []string{"x", "y"}...))
	var n Named = P{"q"}
	fmt.Println(n, n.Name())
	var a Alias = P{"r"}
	var c Celsius = 3.5
	fmt.Printf("%v %T %T\n", a, a, c)
	s := []int{1, 2, 3, 4, 5}
	t := s[1:3:4]
	fmt.Println(t, len(t), cap(t))
	f := Map[int, string]
	fmt.Println(f([]int{1, 2}, func(i int) string { return fmt.Sprint(i * 2) }))
	g := p2.String
	fmt.Println(g())
	h := P.Name
	fmt.Println(h(P{"z"}))
	arr := (*[2]int)(s)
	arr[0] = 99
	fmt.Println(s[0], *arr)
}

var p2 = P{"m"}

func init() {
	fmt.Println("init1")
}

func init() {
	fmt.Println("init2")
}
