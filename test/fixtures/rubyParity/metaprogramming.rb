class Ghost
  def method_missing(name, *args, &blk)
    if name.to_s.start_with?("say_")
      "#{name.to_s.sub("say_", "")}!#{args.inspect}"
    else
      super
    end
  end
  def respond_to_missing?(name, include_private = false) = name.to_s.start_with?("say_") || super
end
g = Ghost.new
p g.say_hello(1, 2), g.respond_to?(:say_x), g.respond_to?(:other)
begin; g.other; rescue NoMethodError => e; p e.message; end
p 1.send(:+, 2), "ab".public_send(:upcase), [3, 1].send(:sort)
class Secret; private def hide = 42; end
p Secret.new.send(:hide)
begin; Secret.new.public_send(:hide); rescue NoMethodError => e; p e.message; end
class Dyn
  [:alpha, :beta].each_with_index do |n, i|
    define_method(n) { i * 10 }
    define_method("#{n}=") { |v| instance_variable_set("@#{n}", v) }
  end
  define_method(:add) { |x, y = 1| x + y }
end
d = Dyn.new
p d.alpha, d.beta, d.add(1), d.add(1, 5), d.respond_to?(:alpha)
d.alpha = 3
p d.instance_variable_get(:@alpha), d.instance_variables, d.instance_variable_defined?(:@beta)
begin; d.add; rescue ArgumentError => e; p e.message; end
o = Object.new
o.instance_variable_set(:@x, 5)
p o.instance_eval { @x * 2 }, o.instance_exec(3) { |n| @x * n }
String.class_eval do
  def shout = upcase + "!"
end
p "hi".shout
module Loud
  def speak = super.upcase
end
class Dog
  prepend Loud
  def speak = "woof"
end
p Dog.new.speak, Dog.ancestors.take(3)
m = 5.method(:+)
p m.call(3), [1, 2].map(&10.method(:*)), m.arity, m.name, m.owner, m.receiver
class Dog
  alias_method :bark, :speak
end
p Dog.new.bark, Dog.method_defined?(:bark), Dog.instance_method(:speak).class rescue p $!
p Object.const_get(:Dog), Math.const_get(:PI), Dog.const_defined?(:String)
class Cnt; @@n = 1; end
p Cnt.class_variable_get(:@@n), Cnt.class_variable_defined?(:@@n)
obj = Object.new
obj.define_singleton_method(:hi) { "hi from obj" }
p obj.hi
p 1.instance_eval { self + 1 }, 2.instance_exec(3) { |x| self * x }, String.class_eval { name }
begin
  1.instance_eval(1) { }
rescue => e
  p e
end
class Foo; end
Foo.class_exec(:hi) { |n| define_method(n) { 1 } }
p Foo.new.hi
class Reflected
  BAR = 1
  BAZ = 2
  def initialize = (@a = 1; @b = 2)
  def hi = 1
end
f = Reflected.new
p f.instance_variables, f.respond_to?(:hi), Reflected.method_defined?(:hi), Reflected.public_method_defined?(:hi)
p Reflected.instance_method(:hi).owner, f.method(:hi).arity
p defined?(@iv = 1)
p defined?(x = 1)
p defined?(@a += 1)
p proc { |a, b = 1, *c, d, e:, f: 2, **g, &h| }.parameters
p lambda { |a, b = 1, *c, d, e:, f: 2, **g, &h| }.parameters
p proc { |(x, y), z| }.parameters, proc { }.parameters, lambda { }.parameters, proc { |*| }.parameters, proc { |a,| }.parameters
p proc { _1 + _2 }.parameters, proc { it }.parameters, lambda { it }.parameters
def m(a, b = 1, *rest, c, k:, j: 1, **opts, &blk) = nil
def n(*, **, &) = nil
def o(...) = nil
p method(:m).parameters, method(:n).parameters, method(:o).parameters, method(:puts).parameters
p proc { |a| }.parameters(lambda: true)
def f(*) = g(*)
def g(*a) = p(a)
f(1,2)
def h(**) = i(**)
def i(**k) = p(k)
h(a: 1)
def j(&) = [1].map(&)
p j { _1 + 1 }
