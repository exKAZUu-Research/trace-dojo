x = 5
p %W[a#{x} b], %s(sym), __ENCODING__, "abc".encoding, %I[a#{x} b]
p "é".bytesize
class Foo
  def initialize(v) = @v = v
  def deconstruct_keys(keys) = {v: @v}
  def deconstruct = [@v]
end
case Foo.new(3)
in Foo(v:) then p v
end
case Foo.new(4)
in Foo[w] then p w
end
case {name: "a", age: 20}
in {name: String => name, **rest} then p name, rest
end
case [1, "a", :b]
in [Integer | Float, String, Symbol] => all then p all
end
val = 3
case 3
in ^val then p :ok
end
case 4
in (1..3) then p :low
in (4..) then p :high
end
case {k: nil}
in {k: nil} then p :nilv
end
arr = [[:add, 1, 2], [:neg, 5], [:unknown]]
arr.each do |cmd|
  r = case cmd
      in [:add, a, b] then a + b
      in [:neg, n] then -n
      in _ then :unknown
      end
  p r
end
def m(a, ...) = p(a, ...)
m(1, 2, 3)
h = {status: 200, body: "ok"}
if h in {status: 200..299}
  p :success
end
def t
  yield
rescue NoMatchingPatternError => e
  p [e.class, e.message]
end
t { case 99; in 1 then 0; end }
t { case 99; in 1 then 0; in 2 then 1; end }
t { case 99; in String then 0; end }
t { case [1]; in [a, b] then 0; end }
t { case({a: 1}); in {b:} then 0; end }
t { case({a: 1}); in {a: String} then 0; end }
t { case 5; in Integer => n if n > 9 then 0; end }
t { 99 => 1 }
t { 99 => String }
t { [1] => [a, b] }
t { {a: 1} => {b:} }
t { {a: 1} => {a: String} }
t { 5 => 1 | 2 }
t { [1,2] => [*, String, *] }
t { 5 => ^(2+2) }
t { {a: 1} => {a: 1, **nil} }
t { {a: 1, b: 2} => {a: 1, **nil} }
t { "str" => [x] }
t { 1 => {a:} }
