class Point
  def initialize(x, y)
    @x = x
    @y = y
  end
end
pt = Point.new(1, 2)
s = pt.inspect
p s.start_with?("#<Point:0x"), s.end_with?(" @x=1, @y=2>"), s.length
class Named
  def initialize(n) = @name = n
  def to_s = "Named(#{@name})"
end
n = Named.new("a")
puts n, "#{n}", [n].join
p n.to_s, [n].map(&:to_s)
class Integer
  def double = self * 2
end
p 4.double, 3.times.map(&:double)
class String
  def shout = upcase + "!"
end
p "hi".shout
module Walkable
  def walk = "#{name} walks"
end
class Person
  include Walkable
  include Comparable
  attr_reader :name, :age
  def initialize(name, age) = (@name, @age = name, age)
  def <=>(o) = age <=> o.age
  def to_s = "#{name}(#{age})"
  def inspect = "#<Person #{name}>"
end
people = [Person.new("A", 30), Person.new("B", 20), Person.new("C", 25)]
p people.sort, people.min, people.max.name, people.sort_by(&:name).map(&:to_s), people.map(&:walk)
p Person.ancestors.include?(Walkable), Person.include?(Comparable), people[0] > people[1], people[1].clamp(people[2], people[0])
puts people.sort.join(", ")
p people.sum(&:age), people.group_by { |x| x.age > 22 }.transform_values { |v| v.map(&:name) }
o = Object.new
p o.frozen?, o.dup.equal?(o), 1.frozen?, :a.frozen?, "x".dup.frozen?, nil.to_a, nil.to_s, nil.inspect
x = [1, [2, 3]]
y = x.dup
y[1] << 4
p x, y, x.equal?(y), x == y
z = "abc".freeze
p z.frozen?, z.upcase.frozen?, (z << "d" rescue $!.class)
p 1.class, 1.0.class, nil.class, true.class, :s.class, "s".class, [].class, {}.class, (1..2).class, Point.class, Point.superclass, Integer.ancestors.take(4)
p 10.is_a?(Comparable), 10.is_a?(Numeric), 1.0.kind_of?(Integer), Integer === 3, (1..3) === 2, String === "s"
def describe(x)
  case x
  when Integer, Float then "number"
  when String then "string"
  when nil then "nil"
  when Array then "array of #{x.size}"
  else "other"
  end
end
p [1, 2.0, "s", nil, [1], :sym].map { |v| describe(v) }
p __method__.inspect
p 5.then { |v| v + 1 }, 5.tap { |v| p v }.succ, 3.itself
pp({ a: 1, b: [1, 2] })
pp 1, "two"
q = pp
p q
