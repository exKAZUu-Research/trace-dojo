package main

import (
	"fmt"
	"time"
)

func main() {
	start := time.Now()
	done := make(chan struct{})
	go func() {
		defer close(done)
		time.Sleep(3 * time.Second)
	}()
	<-done
	el := time.Since(start)
	fmt.Println(el.Round(time.Second), el >= 3*time.Second)
	ch := make(chan int, 1)
	close(ch)
	defer func() {
		r := recover()
		fmt.Println("recovered:", r)
		var nilch chan int
		defer func() { fmt.Println("again:", recover()) }()
		close(nilch)
	}()
	ch <- 1
}
