package main

import "fmt"

func worker(id int, jobs <-chan int, results chan<- int) {
	for j := range jobs {
		results <- j * 2
	}
	_ = id
}

func main() {
	ch := make(chan int)
	go func() {
		for i := 0; i < 3; i++ {
			ch <- i
		}
		close(ch)
	}()
	for v := range ch {
		fmt.Println("got", v)
	}
	jobs := make(chan int, 5)
	results := make(chan int, 5)
	for w := 1; w <= 3; w++ {
		go worker(w, jobs, results)
	}
	for j := 1; j <= 5; j++ {
		jobs <- j
	}
	close(jobs)
	sum := 0
	for a := 1; a <= 5; a++ {
		sum += <-results
	}
	fmt.Println("sum", sum)
	done := make(chan bool)
	go func() { done <- true }()
	v, ok := <-done
	fmt.Println(v, ok, len(results), cap(results))
	select {
	case x := <-results:
		fmt.Println("x", x)
	default:
		fmt.Println("default")
	}
	var c chan int
	fmt.Println(c == nil)
	fmt.Printf("%T %T\n", jobs, results)
	d := make(chan int)
	<-d
}
