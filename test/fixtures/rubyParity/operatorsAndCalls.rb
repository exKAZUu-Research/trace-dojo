class Vec
  attr_reader :x, :y
  def initialize(x, y) = (@x, @y = x, y)
  def +(o) = Vec.new(x + o.x, y + o.y)
  def -@ = Vec.new(-x, -y)
  def [](i) = i == 0 ? x : y
  def []=(i, v)
    if i == 0 then @x = v else @y = v end
  end
  def x=(v)
    @x = v * 10
  end
  def ==(o) = o.is_a?(Vec) && x == o.x && y == o.y
  def to_s = "(#{x}, #{y})"
  def coerce(n) = [Vec.new(n, n), self]
end
a = Vec.new(1, 2)
b = Vec.new(3, 4)
puts a + b, -a, a[0], a[1]
a[1] = 9
a.x = 2
puts a, a == Vec.new(20, 9), a != b
n = nil
p n&.length, "ab"&.length, ::Vec.name
i = 0
begin
  i += 1
end while i < 3
p i
for x, y in [[1, 2], [3, 4]]
  p x + y
end
p x
$g = 1
def bump = $g += 1
bump
p $g
def kw(a, b: 2, **rest) = [a, b, rest]
x = 5
p({x:}, kw(1, c: 3), kw(1, **{b: 9}))
def with_block(&blk) = blk
pr = with_block { |v| v * 3 }
p pr.call(2), pr.class, with_block.nil?
def maybe = block_given? ? yield(1) : :no
p maybe, maybe { |v| v + 1 }
pr2 = Proc.new { |a, b| "#{a}-#{b}" }
p pr2.call(1, 2), pr2.call([3, 4]), proc { |*a| a }.call(1, 2)
[[1, [2, 3]], [4, [5, 6]]].each { |a, (b, c)| p [a, b, c] }
m, (n2, o) = 1, [2, 3]
p m, n2, o
h = {a: 1, b: 2}
h.each_with_index { |(k, v), i| p [k, v, i] }
$stdout.puts "out"
STDOUT.print "print\n"
$stdout.write("w", 1, "\n")
$stdout << "chain" << "\n"
putc "xyz"
putc 10
module Greeter
  def greet = "hi #{name}"
end
o = Object.new
class Named; def name = "n"; end
nn = Named.new
nn.extend(Greeter)
p nn.greet, nn.is_a?(Greeter), Named.include?(Greeter)
p [1, 2, 3].sum { |v| v.to_f }, 10.divmod(3), (-7).abs, 3.14.floor(1), 7.lcm(3)
p "%s and %p" % ["str", "str"], "%-6.2f|" % 3.14159, "%+05d" % 42, "%x" % -255, "%o" % 8, "%b" % -5, "%.3s" % "abcdef"
p 1 <=> "a", [1, 2] <=> [1, 3], nil.to_i, :abc <=> :abd, "10" + 10.to_s, 3.7.divmod(1)
