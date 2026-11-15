package main

import (
	"fmt"
	"maps"
	"slices"
)

func Count(n int) func(func(int) bool) {
	return func(yield func(int) bool) {
		for i := 0; i < n; i++ {
			if !yield(i) {
				return
			}
		}
	}
}

func Pairs(m []string) func(func(int, string) bool) {
	return func(yield func(int, string) bool) {
		for i, s := range m {
			if !yield(i, s) {
				return
			}
		}
	}
}

func find() int {
	for i := range Count(10) {
		if i == 4 {
			return i * 100
		}
	}
	return -1
}

func main() {
outer:
	for i := 0; i < 3; i++ {
		for j := 0; j < 3; j++ {
			if j == 2 {
				continue outer
			}
			if i == 2 {
				break outer
			}
			fmt.Println(i, j)
		}
	}
	for i := range 3 {
		fmt.Print(i, " ")
	}
	fmt.Println()
	var n int64 = 2
	for i := range n {
		fmt.Printf("%T ", i)
	}
	for range 2 {
		fmt.Print("x")
	}
	fmt.Println()
	i := 0
loop:
	if i < 3 {
		fmt.Print("g", i)
		i++
		goto loop
	}
	fmt.Println()
	for v := range Count(5) {
		if v == 3 {
			break
		}
		fmt.Print(v)
	}
	fmt.Println()
	for k, v := range Pairs([]string{"a", "b"}) {
		fmt.Print(k, v, ";")
	}
	fmt.Println(find())
	m := map[string]int{"b": 2, "a": 1}
	keys := slices.Sorted(maps.Keys(m))
	fmt.Println(keys)
	for i, v := range slices.All([]int{7, 8}) {
		fmt.Print(i, v)
	}
	fmt.Println()
sw:
	switch {
	case true:
		for {
			break sw
		}
	}
	fmt.Println("end")
}
