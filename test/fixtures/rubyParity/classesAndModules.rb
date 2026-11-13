class Animal
  attr_reader :name
  @@count = 0
  SOUND = "..."
  def initialize(name)
    @name = name
    @@count += 1
  end
  def self.count = @@count
  def speak = "#{name} says #{sound}"
  def sound = self.class::SOUND
  def to_s = "#<#{self.class.name} #{@name}>"
  def <=>(other) = name <=> other.name
  include Comparable
  protected
  def secret = 42
  private
  def hidden = 1
end
class Dog < Animal
  SOUND = "Woof"
  def initialize(name, breed)
    super(name)
    @breed = breed
  end
  def speak
    super + "!"
  end
  def peek(o) = o.secret
end
d = Dog.new("Rex", "lab")
a = Animal.new("Generic")
puts d.speak, a.speak
p Animal.count
puts d
p d.is_a?(Animal), d.instance_of?(Animal), Dog.superclass, Dog.ancestors.take(3)
p d.peek(a)
begin; a.secret; rescue NoMethodError => e; p e.message; end
begin; a.hidden; rescue NoMethodError => e; p e.message; end
p [Dog.new("b", 1), a, d].sort.map(&:name)
p a < d, a.between?(a, d), [a, d].max.name
module Greet
  def hello = "hi from #{self.class}"
end
class Dog
  include Greet
  def extra = :reopened
end
p d.hello, d.extra, Dog.include?(Greet)
module Util
  PI2 = 6.28
  def self.double(x) = x * 2
  module_function
  def triple(x) = x * 3
end
p Util.double(2), Util.triple(3), Util::PI2
class Stack
  def initialize; @items = []; end
  def push(x); @items.push(x); self; end
  def pop = @items.pop
  def size = @items.size
  def each(&b) = @items.each(&b)
  include Enumerable
end
s = Stack.new.push(3).push(1).push(2)
p s.sort, s.include?(1), s.min, s.sum, s.to_a, s.first, s.select(&:odd?), s.sort_by { |x| -x }
p s.inject(:+), s.each_slice(2).to_a, s.min_by { |x| -x }
class Animal
  def ==(o) = o.is_a?(Animal) && name == o.name
end
p Animal.new("x") == Animal.new("x"), Animal.new("x").equal?(Animal.new("x"))
p d.frozen?
obj = Object.new

class Foo; def initialize(a); end; end
begin; Foo.new; rescue ArgumentError => e; p e.message; end
p Foo.new(1).class, Foo.name, Foo.to_s, Foo.class, Comparable.class
class Bar < Foo; end
p Bar.superclass.superclass
begin; class Foo < String; end; rescue TypeError => e; p e.message; end
