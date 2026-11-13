s = "Hello, World"
p s.length, s.upcase, s.downcase, s.swapcase, s.reverse, s[0], s[-1], s[0, 5], s[0..4], s[7..], s[100], s[1, 0]
p s.index("o"), s.rindex("o"), s.index("o", 5), s.include?("World"), s.start_with?("He"), s.end_with?("d")
p s.sub("o", "0"), s.gsub("o", "0"), s.gsub("l") { |m| m.upcase }, s.tr("lo", "01"), s.delete("l"), s.squeeze, s.count("lo")
p s.split(", "), "a b  c".split, "a,b,,c,,".split(","), "abc".split(""), "a-b-c".split("-", 2)
p s.chars.first(3), s.bytes.first(2), s.center(20, "*"), s.ljust(15, "."), s.rjust(15), "  x  ".strip, " x ".lstrip, " x ".rstrip
p "abc\n".chomp, "abc".chop, "abc".chomp("c"), "a".ord, 97.chr, "%05d" % 42, "%s-%s" % ["a", "b"], "ab" * 3, "a" + "b"
p "hello world".capitalize, "HELLO".casecmp?("hello"), "a" <=> "b", "b" == "b", "abc".eql?("abc"), "x".frozen?
p "3.7".to_f, "42abc".to_i, "0x1A".hex, "ff".to_i(16), "abc".to_sym, "12".to_i + 1, "1_000".to_i, " 12 ".to_i, "-3.5e2".to_f
p "az".succ, "zz".succ, "a9".succ, "Zz".succ, "1.9".succ, "".succ
x = "abc"
x[1] = "ZZ"
p x
x.insert(1, "-")
p x, x.prepend(">"), x.concat("!", "?")
y = "hello"
y.upcase!
p y, y.downcase!.nil?, y.capitalize!, y.capitalize!
p "a,b".partition(","), "a,b,c".rpartition(","), "line1\nline2\n".lines, "abc".each_char.to_a
p "abc".start_with?("x", "a"), "%-5s|" % "ab", "%+d %+d" % [3, -3], "%.3f" % 2.0, "%e" % 12345.678, "%g %g" % [0.0001, 123456789.0]
p "あいう".length, "あいう".reverse, "あいう"[1], "日本語".chars, "ｱ".bytesize
p "abcdef".slice(1..3), "abcdef".slice!(0), "%c%c" % [65, "BC"], "%x %o %b %X" % [255, 8, 5, 255], "%08.3f" % 3.14159
p "Ruby".each_char.map(&:upcase), "aaa".replace("b"), "abc".upto("abe").to_a, "a".."e", ("a".."e").to_a
puts "tab\tnew\\n #{1 + 1} é"
p 'single #{x} \n'
p "%5.1f%%" % 99.55, "%s" % nil, "%p" % [nil], format("%-10s|%5d", "name", 42)
p "hello"[1..-2], "hello".delete_prefix("he"), "hello".delete_suffix("lo"), "abc".sum rescue p $!
p "CamelCaseString".gsub("C", "c"), "hello world".split.map(&:capitalize).join(" ")
