a = [5, 3, 8, 1, 9, 2]
p a.sort, a.sort.reverse, a.max, a.min, a.sum, a.minmax, a.sort { |x, y| y <=> x }, a.max(2), a.min(2), a.take(2), a.drop(4)
p a.first, a.last(2), a.length, a.include?(8), a.index(8), a.find { |x| x > 4 }, a.select(&:even?), a.reject(&:even?), a.partition(&:odd?)
p a.map { |x| x * 2 }, a.each_slice(2).to_a, a.each_cons(3).first, a.inject(:+), a.reduce(1) { |m, x| m * x }, a.count(&:odd?), a.group_by(&:odd?)
p a.zip([1] * 6), a.each_with_index.select { |x, i| i.even? }, a.each_with_object([]) { |x, m| m << x if x > 3 }, a.sum.fdiv(a.size)
b = a.dup
b.push(10).unshift(0)
p b, b.pop, b.shift, b, b.insert(2, :x), b.delete(:x), b, b.delete_at(0), b.compact, [nil, 1, nil].compact
p [1, [2, [3, [4]]]].flatten, [1, [2, [3, [4]]]].flatten(1), [1, 1, 2, 3, 3].uniq, [3, 1, 2].sort!.first, [1, 2, 3].rotate, [1, 2, 3].rotate(-1)
p [1, 2] + [3], [1, 2, 2, 3] - [2], [1, 2] * 2, [1, 2] & [2, 3], [1, 2] | [2, 3], [[1, 2], [3, 4]].transpose, [1, 2].product([3, 4])
p [1, 2, 3].combination(2).to_a, [1, 2, 3].permutation(2).count, [1, 2, 3].each_slice(2).map(&:sum), Array.new(3), Array.new(2, 0), Array.new(3) { |i| i * i }
words = ["apple", "fig", "banana", "kiwi", "plum", "date", "pear", "lime", "peach"]
p words.sort_by(&:length), words.min_by(&:length), words.max_by(&:length), words.group_by(&:size), words.sort_by { |w| [w.size, w] }
p words.tally, words.map(&:size).tally, words.sum(""), words.join(", "), words.each_with_index.map { |w, i| "#{i}:#{w}" }.first(2)
p words.sort, words.sort.reverse, words.min(3), words.max_by(2, &:size), words.minmax_by(&:size), words.find_index("kiwi")
c = [1, 2, 3, 4, 5, 6]
c.delete_if(&:even?)
p c, c.fill(0), [1, 2, 3].fill { |i| i * 10 }, [4, 5].each_index.to_a, [1, 2, 3].reverse_each.to_a, [1, 2, 3].cycle.first(7)
p [1, 2, 3].all? { |x| x > 0 }, [1, 2, 3].any?(&:zero?), [].none?, [1, nil].one?, [1, 2, 3].sum { |x| x * x }, [0.1, 0.2, 0.3].sum, [1, 2, 3].filter_map { |x| x * 2 if x.odd? }
p [[1, :a], [2, :b]].to_h, [[1, 2], [3, 4]].map { |a, b| a + b }, [1, 2, 3].each_with_index.to_a, [3, 5, 2].each.with_index(1).to_a
d = [1, 2, 3]
d[5] = 6
p d, d[1..2], d[1, 2], d[-2..], d.values_at(0, 2, 10), d.dig(0), [[1, [2]]].dig(0, 1, 0), d.fetch(1), d.fetch(10, :none), d.slice(1..)
d[0, 2] = [:a, :b, :c]
p d, d.flatten.size, [1, 2, 3].map.with_index { |x, i| x * i }, [1, 2, 3].each_slice(2).with_index.map { |s, i| s.sum * i }
e = [3, 1, 2]
p e.frozen?, e.freeze.frozen?
begin; e << 4; rescue => err; p err.class, err.message; end
p [1, 2, 3].chunk_while { |a, b| b == a + 1 }.to_a, [1, 2, 4, 5, 7].slice_when { |a, b| b != a + 1 }.to_a, [1, 2, 3].sum / [1, 2, 3].size.to_f
p [[3, "c"], [1, "a"], [2, "b"]].sort, [[1, "b"], [1, "a"]].min, ["b", "B", "a"].sort, ["b", "B", "a"].sort_by(&:downcase), [0.5, 1, 0.25].sort
p (1..20).to_a.shuffle(random: Random.new(42)), (1..10).to_a.sample(random: Random.new(1)), [1, 2, 3].sample(2, random: Random.new(3)), (1..100).to_a.sample(15, random: Random.new(7))
p [1, 2, 3].inspect, [1, 2, 3].to_s, [nil, true, "s", :sym, 1.5, [1]].to_s, [1, 2, 3].first(10), [].sum, [].max, [1, 2].cycle(2).to_a
p (1..10).each_slice(3).to_a, (1..6).each_cons(2).count
