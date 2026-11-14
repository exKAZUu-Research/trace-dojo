s = Set.new([3, 1, 2, 3])
p s, s.size, s.include?(2), s.member?(5), Set[], Set.new, s.to_a, s.sort, s.map { |x| x * 2 }, s.min, s.sum
s << 10
s.add(1)
p s, s.add?(1), s.add?(99), s.delete(3), s.length, s.empty?
a = Set[1, 2, 3]
b = Set[2, 3, 4]
p a | b, a & b, a - b, a ^ b, a + b, a.subset?(Set[1, 2, 3, 4]), a.superset?(Set[1]), a <= b, a == Set[3, 2, 1], a.disjoint?(Set[9]), a.intersect?(b)
p a.select(&:odd?), a.reject(&:odd?), a.group_by(&:odd?), a.partition(&:odd?), a.to_set.equal?(a), [1, 1, 2].to_set, a.each { |x| x }, a.first, a.first(2)
p Set.new("hello".chars), Set.new([1, 2]) { |x| x * 10 }, a.frozen?, a.dup << 5, a, a.inspect, a.to_s
h = {}
h[Set[1, 2]] = :x
p h[Set[2, 1]], Set[[1, 2], [1, 2]].size, Set[Set[1]], a.filter_map { |x| x * 3 if x > 1 }, a.count
