package main

import (
	"fmt"
	"iter"
	"maps"
	"slices"
	"strings"
)

func Count(n int) iter.Seq[int] {
	return func(yield func(int) bool) {
		for i := 0; i < n; i++ {
			if !yield(i) {
				fmt.Println("  (stopped early at", i, ")")
				return
			}
		}
	}
}

func Enumerate[T any](s []T) iter.Seq2[int, T] {
	return func(yield func(int, T) bool) {
		for i, v := range s {
			if !yield(i, v) {
				return
			}
		}
	}
}

func Fib() iter.Seq[int] {
	return func(yield func(int) bool) {
		a, b := 0, 1
		for yield(a) {
			a, b = b, a+b
		}
	}
}

func main() {
	for i := range Count(3) {
		fmt.Print(i, " ")
	}
	fmt.Println()
	for i := range Count(10) {
		if i == 2 {
			break
		}
		fmt.Println("got", i)
	}
	for i, s := range Enumerate([]string{"a", "b"}) {
		fmt.Println(i, s)
	}
	for f := range Fib() {
		if f > 100 {
			break
		}
		fmt.Print(f, " ")
	}
	fmt.Println()
	fmt.Println(slices.Collect(Count(5)))
	m := map[string]int{"x": 1, "y": 2, "z": 3}
	fmt.Println(slices.Sorted(maps.Keys(m)))
	next, stop := iter.Pull(Count(3))
	for {
		v, ok := next()
		if !ok {
			break
		}
		fmt.Print("pulled ", v, "; ")
	}
	stop()
	fmt.Println()
	for part := range strings.SplitSeq("a,b,c", ",") {
		fmt.Print("[", part, "]")
	}
	fmt.Println()
	for f := range strings.FieldsSeq("  p  q r ") {
		fmt.Print("<", f, ">")
	}
	fmt.Println()
	for l := range strings.Lines("one\ntwo\nthree") {
		fmt.Printf("%q ", l)
	}
	fmt.Println()
	sum := 0
	for _, v := range maps.All(m) {
		sum += v
	}
	fmt.Println(sum)
}
