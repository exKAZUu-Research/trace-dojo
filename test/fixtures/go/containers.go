package main

import (
	"container/list"
	"container/ring"
	"fmt"
)

func dump(l *list.List) {
	for e := l.Front(); e != nil; e = e.Next() {
		fmt.Print(e.Value, " ")
	}
	fmt.Println("| len", l.Len())
}

func main() {
	l := list.New()
	e4 := l.PushBack(4)
	e1 := l.PushFront(1)
	l.InsertBefore(3, e4)
	l.InsertAfter(2, e1)
	dump(l)
	l.MoveToBack(e1)
	dump(l)
	l.MoveToFront(e4)
	dump(l)
	l.Remove(e4)
	dump(l)
	fmt.Println(l.Front().Value, l.Back().Value, l.Front().Prev() == nil)
	l2 := list.New()
	l2.PushBack("a")
	l2.PushBack("b")
	l.PushBackList(l2)
	l.PushFrontList(l2)
	dump(l)
	for e := l.Back(); e != nil; e = e.Prev() {
		fmt.Print(e.Value, ",")
	}
	fmt.Println()
	var zero list.List
	zero.PushBack(1.5)
	dump(&zero)
	fmt.Println(l.Remove(e4))
	dump(l)
	r := ring.New(4)
	for i := 0; i < r.Len(); i++ {
		r.Value = i * i
		r = r.Next()
	}
	r.Do(func(p any) { fmt.Print(p, " ") })
	fmt.Println()
	r = r.Move(2)
	r.Do(func(p any) { fmt.Print(p, " ") })
	fmt.Println()
}
