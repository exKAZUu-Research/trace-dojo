package main

import (
	"fmt"
	"sync"
)

type Counter struct {
	mu sync.Mutex
	n  map[string]int
}

func (c *Counter) Inc(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.n[key]++
}

func main() {
	var wg sync.WaitGroup
	c := Counter{n: map[string]int{}}
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c.Inc("k")
		}()
	}
	wg.Wait()
	fmt.Println(c.n["k"])
	var total int
	var mu sync.Mutex
	var wg2 sync.WaitGroup
	for i := 1; i <= 10; i++ {
		wg2.Go(func() {
			mu.Lock()
			total += i
			mu.Unlock()
		})
	}
	wg2.Wait()
	fmt.Println(total)
	var once sync.Once
	for i := 0; i < 3; i++ {
		once.Do(func() { fmt.Println("once") })
	}
	results := make([]int, 5)
	var wg3 sync.WaitGroup
	for i := range 5 {
		wg3.Add(1)
		go func(n int) {
			defer wg3.Done()
			results[n] = n * n
		}(i)
	}
	wg3.Wait()
	fmt.Println(results)
}
