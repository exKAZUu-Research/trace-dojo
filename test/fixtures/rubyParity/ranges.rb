r = (1..10)
p r, r.to_a, r.sum, r.size, r.include?(5), r.cover?(11), r.min, r.max, r.first(3), r.last(3), r.step(3).to_a, r.select(&:even?), r.each_slice(4).to_a
p (1...10).to_a.last, (1...10).size, ('a'..'e').to_a, ('a'..'e').include?("c"), (1..10) === 5, (1.0..2.0).include?(1.5), (1..).first(3), (..5).include?(3)
p (1..10).map { |x| x * x }.select(&:even?), (1..3).reduce(:*), (1..4).inject { |a, b| a * b }, (1..3).to_a.reverse, (3..1).to_a, (1..10).find { |x| x % 7 == 0 }
p (1..10).each_with_object([]) { |x, a| a << x if x.odd? }, (1..5).each_cons(2).to_a.length, (0...5).map { |i| i * 2 }, ('aa'..'ad').to_a, (1..10) .count(&:even?)
p (1..2).step(0.5).to_a rescue p $!.class
p 1.step(2, 0.5).to_a, (1..10).sum { |x| x }, (1..10).min(2), (1..10).max_by { |x| x % 4 }, (1..10).group_by { |x| x % 3 }, (1..10).partition(&:odd?)
case 75
when 90.. then puts "A"
when 70...90 then puts "B"
else puts "C"
end
p (1..10) == (1..10), (1..10).eql?(1..10), (1..10).hash == (1..10).hash, (1..10).to_s, (1...10).inspect, (1..nil).to_s, Range.new(1, 3).to_a rescue p $!.class
