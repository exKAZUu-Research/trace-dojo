puts "hello"
x = 3
y = x * 2 + 1
puts y
p 10 / 3, -7 / 2, 7 % -3, 2**10, 10.0 / 4
s = "abc"
s << "def"
puts s.upcase, s.length
a = [3, 1, 2]
p a.sort, a.map { |v| v * 10 }, a.sum
h = { "a" => 1, b: 2 }
h[:c] = 3
p h
3.times do |i|
  puts "i=#{i}"
end
def add(a, b = 10)
  a + b
end
puts add(1), add(1, 2)
class Point
  attr_accessor :x, :y
  def initialize(x, y)
    @x = x
    @y = y
  end
  def to_s
    "(#{@x}, #{@y})"
  end
end
pt = Point.new(1, 2)
puts pt
pt.x += 5
p pt.x
begin
  raise ArgumentError, "bad"
rescue => e
  puts "#{e.class}: #{e.message}"
end
i = 0
while i < 3
  i += 1
  next if i == 2
  puts i
end
case 5
when 1..3 then puts "low"
when 4, 5 then puts "mid"
else puts "high"
end
puts [1, 2, 3].select(&:odd?).inspect
printf("%05.2f|%-4s|%x\n", 3.14159, "ab", 255)
puts format("%d items", 3)
nil.foo
