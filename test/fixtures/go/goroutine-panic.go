package main

import (
	"fmt"
	"time"
)

func main() {
	go func() {
		var m map[string]int
		m["a"] = 1
	}()
	time.Sleep(time.Second)
	fmt.Println("not reached")
}
