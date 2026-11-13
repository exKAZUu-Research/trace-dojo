e = [1, 2, 3].each
p e.next, e.next, e.peek, e.next
begin; e.next; rescue StopIteration => ex; p ex.message, ex.result; end
e.rewind
p e.next
fib = Enumerator.new do |y|
  a, b = 0, 1
  loop do
    y << a
    a, b = b, a + b
  end
end
p fib.take(10), fib.first(5), fib.lazy.select(&:even?).first(5), fib.next, fib.next, fib.next
p fib.each_with_index.first(3), fib.lazy.map { |x| x * 2 }.take(4).to_a
gen = Enumerator.new { |y| y.yield 1, 2; y << 3; :done }
p gen.to_a, gen.next, gen.next
p (1..Float::INFINITY).lazy.map { |i| i * i }.select(&:even?).first(3)
p (1..20).lazy.select(&:odd?).map { |x| x * 3 }.to_a
p 1.step.lazy.map { |x| x * 10 }.first(3), Enumerator.produce(1) { |x| x * 2 }.take(6)
ext = [10, 20].each_with_index
p ext.next, ext.next
it2 = [1, 2].each
r = loop do
  p it2.next
end
p r
def count_up
  return to_enum(:count_up) unless block_given?
  yield 1
  yield 2
  3
end
c = count_up
p c.next, c.next
begin; c.next; rescue StopIteration => ex; p ex.result; end
p [4, 5].map.with_index(1).to_a, [4, 5].each.with_index(1).map { |x, i| x * i }
