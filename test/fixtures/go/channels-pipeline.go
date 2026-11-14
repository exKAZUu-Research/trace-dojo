package main

import "fmt"

func gen(nums ...int) <-chan int {
	out := make(chan int)
	go func() {
		for _, n := range nums {
			out <- n
		}
		close(out)
	}()
	return out
}

func sq(in <-chan int) <-chan int {
	out := make(chan int)
	go func() {
		for n := range in {
			out <- n * n
		}
		close(out)
	}()
	return out
}

func main() {
	for v := range sq(sq(gen(1, 2, 3))) {
		fmt.Println(v)
	}
	ch := make(chan string, 2)
	ch <- "a"
	ch <- "b"
	fmt.Println(len(ch), cap(ch))
	close(ch)
	for s := range ch {
		fmt.Println(s)
	}
	v, ok := <-ch
	fmt.Printf("%q %v\n", v, ok)
}
