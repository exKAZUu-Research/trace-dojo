data = { "apple" => [1, 2, 3], "banana" => { color: "yellow", count: 12 }, "cherry" => (1..20).to_a, "date" => nil }
pp data
pp (1..40).to_a
pp [{ name: "Alice", age: 30, hobbies: ["reading", "chess"] }, { name: "Bob", age: 25, hobbies: ["soccer", "music", "cooking"] }]
pp "short"
pp "line one\nline two\nline three is quite long and keeps going for a while to exceed the width\n"
class Point
  def initialize(x, y) = (@x, @y = x, y)
end
pt = Point.new([1, 2, 3] * 10, { key: "value" * 10 })
pp({ a: 1 }, [1, 2])
pp Array.new(3) { |i| Array.new(12) { |j| i * j * 1000 } }
pp({ list: (1..30).map { |i| "item#{i}" } })
