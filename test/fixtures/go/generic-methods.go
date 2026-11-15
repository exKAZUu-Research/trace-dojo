package main

import "fmt"

type Box struct{ v int }

func (b Box) Map[T any](f func(int) T) T { return f(b.v) }

func (b *Box) Set[T ~int | ~int64](x T) { b.v = int(x) }

type List[E any] struct{ items []E }

func (l List[E]) Each[R any](f func(E) R) []R {
	var out []R
	for _, it := range l.items {
		out = append(out, f(it))
	}
	return out
}

type Mapper interface{ Get() int }

func (b Box) Get() int { return b.v }

func main() {
	b := Box{3}
	fmt.Println(b.Map(func(i int) string { return fmt.Sprint(i, "!") }))
	b.Set(int64(7))
	fmt.Println(b.v, b.Map[float64](func(i int) float64 { return float64(i) / 2 }))
	l := List[int]{[]int{1, 2}}
	fmt.Println(l.Each(func(i int) bool { return i > 1 }))
	var m Mapper = b
	fmt.Println(m.Get())
}
