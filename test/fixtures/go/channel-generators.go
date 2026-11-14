package main

import "fmt"

func fib(n int) chan int {
	c := make(chan int)
	go func() {
		x, y := 0, 1
		for i := 0; i < n; i++ {
			c <- x
			x, y = y, x+y
		}
		close(c)
	}()
	return c
}

func fanIn(a, b <-chan int) <-chan int {
	out := make(chan int)
	go func() {
		for a != nil || b != nil {
			select {
			case v, ok := <-a:
				if !ok {
					a = nil
					continue
				}
				out <- v
			case v, ok := <-b:
				if !ok {
					b = nil
					continue
				}
				out <- v
			}
		}
		close(out)
	}()
	return out
}

func main() {
	for v := range fib(10) {
		fmt.Print(v, " ")
	}
	fmt.Println()
	sum := 0
	for v := range fanIn(fib(5), fib(6)) {
		sum += v
	}
	fmt.Println(sum)
	quit := make(chan bool)
	c := make(chan int)
	go func() {
		for i := 0; i < 5; i++ {
			fmt.Println(<-c)
		}
		quit <- true
	}()
	x, y := 0, 1
	for {
		select {
		case c <- x:
			x, y = y, x+y
		case <-quit:
			fmt.Println("quit")
			return
		}
	}
}
