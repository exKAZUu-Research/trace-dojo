package main

import (
	"errors"
	"fmt"
)

type Temp float64

func (t Temp) String() string { return fmt.Sprintf("%.1f°C", float64(t)) }

type PS struct{ n int }

func (p *PS) String() string { return fmt.Sprintf("PS<%d>", p.n) }

type E struct{ code int }

func (e E) Error() string { return fmt.Sprintf("E%d", e.code) }

type Both struct{}

func (Both) String() string { return "stringer" }
func (Both) Error() string  { return "error wins" }

type Gs struct{}

func (Gs) GoString() string { return "Gs!" }
func (Gs) String() string   { return "gs-string" }

type Fm struct{}

func (Fm) Format(f fmt.State, verb rune) { fmt.Fprintf(f, "Fm(%c)", verb) }

type Panicky struct{}

func (*Panicky) String() string { panic("boom in String") }

func main() {
	ts := []Temp{20, 36.6}
	fmt.Println(ts)
	fmt.Printf("%v %s %.2f %d\n", ts, ts, ts, ts)
	fmt.Println(map[string]Temp{"a": 1})
	fmt.Println(struct{ T Temp }{5})
	fmt.Printf("%+v %#v\n", struct{ T Temp }{5}, struct{ T Temp }{5})
	fmt.Println([]*PS{}, []PS{{1}})
	p := &PS{7}
	fmt.Println(p, *p)
	fmt.Println([]error{E{1}, errors.New("x"), nil})
	fmt.Println(Both{})
	fmt.Printf("%v %#v %s\n", Gs{}, Gs{}, Gs{})
	fmt.Printf("%v %d %s|\n", Fm{}, Fm{}, Fm{})
	fmt.Println(Fm{}, []Fm{{}})
	var pn *Panicky
	fmt.Println(pn)
	fmt.Printf("%s|%v\n", &Panicky{}, &Panicky{})
	var tp *Temp
	fmt.Println(tp)
	fmt.Println([]interface{}{Temp(1), E{2}, "s", 3})
	fmt.Printf("%q\n", []Temp{1})
	fmt.Printf("%x\n", Temp(1))
}
