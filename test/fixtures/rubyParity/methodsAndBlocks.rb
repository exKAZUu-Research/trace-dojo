def greet(name, greeting = "Hello", *rest, punct: "!", **opts, &blk)
  s = "#{greeting}, #{name}#{punct}"
  s += rest.inspect unless rest.empty?
  s += opts.inspect unless opts.empty?
  s = blk.call(s) if blk
  s
end
puts greet("Bob")
puts greet("Bob", "Hi")
puts greet("Bob", "Hi", 1, 2)
puts greet("Bob", punct: "?")
puts greet("Bob", x: 1)
puts greet("Bob") { |t| t.upcase }
def kw(a:, b: 2) = a + b
p kw(a: 1), kw(b: 3, a: 1)
begin; kw; rescue ArgumentError => e; p e.message; end
begin; kw(a: 1, c: 2); rescue ArgumentError => e; p e.message; end
begin; greet; rescue ArgumentError => e; p e.message; end
def ret_multi = [1, 2]
a, b = ret_multi
p a + b
def early(x)
  return "neg" if x < 0
  "pos"
end
p early(-1), early(1)
def yielder
  yield 1, 2
  yield [3, 4]
end
yielder { |a, b| p [a, b] }
yielder { |a| p a }
def bg? = block_given?
p bg?, bg? {}
def fact(n) = n <= 1 ? 1 : n * fact(n - 1)
p fact(25)
def splat(*a) = a
p splat(*[1, 2], 3, *nil)
h = {a: 1}
def kwonly(**kw) = kw
p kwonly(**h, b: 2)
def opt(a, b = a * 2, c = b + 1) = [a, b, c]
p opt(1), opt(1, 5)
def mid(a, *b, c) = [a, b, c]
p mid(1, 2), mid(1, 2, 3, 4)
pr = proc { |x, y| [x, y] }
p pr.call(1), pr.call(1, 2, 3), pr.call([4, 5]), pr.(6), pr[7, 8]
la = lambda { |x| x * 2 }
p la.call(3), la.lambda?, pr.lambda?
begin; la.call(1, 2); rescue ArgumentError => e; p e.message; end
sq = ->(x) { x * x }
p sq.(4), [1, 2].map(&sq)
def m_ret
  [1, 2, 3].each { |x| return x * 10 if x == 2 }
  :none
end
p m_ret
counter = 0
inc = -> { counter += 1 }
3.times { inc.call }
p counter
add = proc { |a, b| a + b }
p add.curry[1][2] rescue p $!
p add.arity, sq.arity, proc { |*a| }.arity, lambda { |a, b = 1| }.arity
p method_missing_test rescue p $!.class
