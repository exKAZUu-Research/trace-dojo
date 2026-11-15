package main

import (
	"fmt"
	"sort"
	"sync"
	"time"
)

func worker(id int, jobs <-chan int, results chan<- int, wg *sync.WaitGroup) {
	defer wg.Done()
	for j := range jobs {
		time.Sleep(time.Millisecond)
		results <- j * 2
	}
	_ = id
}

func main() {
	jobs := make(chan int, 100)
	results := make(chan int, 100)
	var wg sync.WaitGroup
	for w := 1; w <= 3; w++ {
		wg.Add(1)
		go worker(w, jobs, results, &wg)
	}
	for j := 1; j <= 9; j++ {
		jobs <- j
	}
	close(jobs)
	go func() {
		wg.Wait()
		close(results)
	}()
	var all []int
	for r := range results {
		all = append(all, r)
	}
	sort.Ints(all)
	fmt.Println(all)
	var rw sync.RWMutex
	data := map[int]int{}
	var wg2 sync.WaitGroup
	for i := 0; i < 5; i++ {
		wg2.Add(2)
		go func() {
			defer wg2.Done()
			rw.Lock()
			data[i] = i * 10
			rw.Unlock()
		}()
		go func() {
			defer wg2.Done()
			rw.RLock()
			_ = data[i]
			rw.RUnlock()
		}()
	}
	wg2.Wait()
	fmt.Println(len(data), data)
	var sm sync.Map
	sm.Store("a", 1)
	sm.Store("b", 2)
	v, ok := sm.Load("a")
	fmt.Println(v, ok)
	act, loaded := sm.LoadOrStore("a", 9)
	fmt.Println(act, loaded)
	sm.Delete("b")
	_, ok = sm.Load("b")
	fmt.Println(ok)
}
