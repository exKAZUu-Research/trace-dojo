package main

import (
	"fmt"
	"time"
)

func main() {
	c1 := make(chan string)
	c2 := make(chan string)
	go func() {
		time.Sleep(1 * time.Second)
		c1 <- "one"
	}()
	go func() {
		time.Sleep(2 * time.Second)
		c2 <- "two"
	}()
	for i := 0; i < 2; i++ {
		select {
		case msg1 := <-c1:
			fmt.Println("received", msg1)
		case msg2 := <-c2:
			fmt.Println("received", msg2)
		}
	}
	c3 := make(chan string, 1)
	go func() {
		time.Sleep(2 * time.Second)
		c3 <- "result 1"
	}()
	select {
	case res := <-c3:
		fmt.Println(res)
	case <-time.After(1 * time.Second):
		fmt.Println("timeout 1")
	}
	ticker := time.NewTicker(500 * time.Millisecond)
	done := make(chan bool)
	go func() {
		time.Sleep(1600 * time.Millisecond)
		done <- true
	}()
	count := 0
loop:
	for {
		select {
		case <-done:
			break loop
		case <-ticker.C:
			count++
		}
	}
	ticker.Stop()
	fmt.Println("ticks", count)
	timer := time.NewTimer(time.Second)
	stopped := timer.Stop()
	fmt.Println("stopped", stopped)
	messages := make(chan string)
	select {
	case msg := <-messages:
		fmt.Println(msg)
	default:
		fmt.Println("no message")
	}
}
