package main

import (
	"fmt"
	"time"
)

func main() {
	t := time.Date(2024, time.February, 29, 13, 4, 5, 123456789, time.UTC)
	fmt.Println(t)
	fmt.Println(t.Year(), t.Month(), t.Day(), t.Hour(), t.Minute(), t.Second(), t.Nanosecond())
	fmt.Println(t.Weekday(), t.YearDay(), int(t.Month()), t.Month().String()[:3])
	y, w := t.ISOWeek()
	fmt.Println(y, w)
	layouts := []string{time.RFC3339, time.RFC3339Nano, time.RFC1123, time.Kitchen, time.ANSIC, time.DateTime, time.DateOnly, time.TimeOnly,
		"2006-01-02", "02/01/06 15:04", "Jan 2, 2006 at 3:04pm (MST)", "Monday 2 January 2006", "2006年1月2日 15時04分", ".000 .999999 _2 __2 Z07:00"}
	for _, l := range layouts {
		fmt.Println(t.Format(l))
	}
	t2 := t.Add(36*time.Hour + 30*time.Minute)
	fmt.Println(t2, t2.Weekday())
	fmt.Println(t2.Sub(t), t.Sub(t2), t2.After(t), t.Before(t2), t.Equal(t))
	fmt.Println(t.AddDate(0, 1, 0), t.AddDate(1, 0, 0))
	fmt.Println(time.Date(2023, 1, 31, 0, 0, 0, 0, time.UTC).AddDate(0, 1, 0))
	fmt.Println(time.Date(2023, 13, 32, 25, 61, 0, 0, time.UTC))
	fmt.Println(t.Truncate(time.Hour), t.Round(time.Minute))
	fmt.Println(t.Unix(), t.UnixMilli(), time.Unix(0, 0).UTC())
	p, err := time.Parse("2006-01-02 15:04", "2025-12-31 23:59")
	fmt.Println(p, err, p.YearDay(), p.Weekday())
	_, err = time.Parse("2006-01-02", "2025-02-30")
	fmt.Println(err)
	var zero time.Time
	fmt.Println(zero, zero.IsZero(), zero.Weekday())
	days := time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC).Sub(time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)).Hours() / 24
	fmt.Println(days)
	fmt.Println(time.Saturday, time.December, time.Weekday(7), time.Month(13))
	fmt.Printf("%v %d %s\n", t.Month(), t.Month(), t.Weekday())
}
