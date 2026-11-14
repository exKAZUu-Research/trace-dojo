h = { "apple" => 3, "banana" => 5, "cherry" => 2 }
p h, h["apple"], h["none"], h.fetch("banana"), h.fetch("x", 0), h.fetch("y") { |k| k * 2 }, h.key?("apple"), h.value?(5), h.key(2), h.size
h["date"] = 7
p h.keys, h.values, h.to_a.first, h.sort_by { |k, v| v }, h.min_by { |_, v| v }, h.max_by { |_, v| v }, h.sum { |_, v| v }, h.count { |k, v| v > 2 }
p h.select { |k, v| v > 2 }, h.reject { |k, v| v > 2 }, h.map { |k, v| [k, v * 2] }.to_h
p h.transform_values { |v| v * 10 }, h.transform_keys(&:upcase), h.filter_map { |k, v| k if v.odd? }, h.sort_by { |k, v| -v }.first(2).to_h, h.invert
h.each { |k, v| puts "#{k}: #{v}" }
h.each_pair { |pair| p pair } rescue nil
h.each_with_index { |(k, v), i| p [k, v, i] } rescue p $!.class
p h.delete("apple"), h.delete("zz"), h, h.any? { |k, v| v > 6 }, h.all? { |k, v| v > 1 }, h.find { |k, v| v == 2 }, h.group_by { |k, v| v.odd? }
counts = Hash.new(0)
"mississippi".each_char { |c| counts[c] += 1 }
p counts, counts.sort_by { |c, n| [-n, c] }, counts.max_by { |_, n| n }, counts.default, counts["z"]
lists = Hash.new { |hash, key| hash[key] = [] }
lists[:a] << 1
lists[:b] << 2
lists[:a] << 3
p lists, lists.keys, lists.dig(:a, 0)
s2 = { name: "Bob", age: 30 }
p s2, s2[:name], s2.merge({ age: 31, city: "Tokyo" }), s2.merge({ age: 1 }) { |k, a, b| a + b }, s2.to_a, s2.slice(:name), s2.except(:age)
s2.store(:job, nil)
p s2, s2.compact, s2.length, s2.empty?, {}.empty?, s2.dig(:name), s2.each_with_object({}) { |(k, v), m| m[v] = k }
nested = { a: { b: { c: 42 } } }
p nested.dig(:a, :b, :c), nested[:a][:b], nested.to_a, nested.inspect, nested.to_s
p({ 1 => "one", nil => 0, [1, 2] => :arr, 1.5 => "f", true => false })
p({ a: 1 } == { a: 1 }, { a: 1 }.eql?({ a: 1.0 }), { a: 1, b: 2 } == { b: 2, a: 1 }, Hash[[[:k, :v]]], [[:a, 1]].to_h { |k, v| [v, k] })
p h.sort, h.sort.to_h, h.min_by(2) { |_, v| v }, h.sum([]) { |k, v| [v] }, h.each_slice(2).to_a, h.zip([1, 2])
str_key = "key"
hk = { str_key => 1 }
str_key << "!"
p hk, hk["key"], hk.keys[0].frozen?
h.update("z" => 26)
p h, h.reject! { |k, v| v > 100 }, h.select! { |k, v| v < 100 }, h.keep_if { true }, h.shift, h
x = {}
x[:a] ||= 0
x[:a] += 1
p x, x.to_h { |k, v| [k.to_s, v] }, x.sum { |k, v| v }, x.frozen?
p h.default = 5, h["nothing"], Hash.new(5).fetch(:a, 1)
begin; {}.fetch(:missing); rescue KeyError => e; p e.message; end
