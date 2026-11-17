s = "Hello World 2024, ruby 3.4"
p s =~ /World/, s =~ /xyz/, s !~ /xyz/, $~
if s =~ /(\d+), (\w+)/
  p $~, $1, $2, $~[0], $`, $', $~.pre_match.size
end
m = s.match(/(?<year>\d{4})/)
p m[:year], m["year"], m.names, m.captures, m.named_captures, m.begin(0), m.end(:year), m.to_a, m.pre_match
p s.scan(/\d+/), s.scan(/(\w)(\d)/), "a1b22c333".scan(/[a-z]\d+/), "aaa".scan(/a*/)
p s.gsub(/o/, "0"), s.sub(/(\w+) (\w+)/, '\2 \1'), s.gsub(/\d/) { |d| (d.to_i * 2).to_s }, s.gsub(/[aeiou]/, "a" => "4", "o" => "0")
p "2024-01-15".split(/-/), "a, b;c  d".split(/[,; ]+/), "abc".split(//), "a1b2c3".split(/\d/), "a-b_c".split(/([-_])/), " a b ".split(/ /)
p "Ruby" =~ /r/i, "line1\nline2" =~ /^line2/, "abc\n" =~ /c$/, "x\ny" =~ /x.y/m, "foo bar".match?(/o b/), "Hi".match(/(z)/)
p s[/\d+/], s[/(\w+) (\d+)/, 2], s.index(/\d/), s.rindex(/\d/), s.start_with?(/hel/i), "abc".slice!(/b/), "a.b".gsub(".", "-")
case "hello123"
when /^\d+$/ then p :digits
when /^[a-z]+\d+$/ then p :mixed
end
re = /(\d+)-(\d+)/
p re.source, re.inspect, re.to_s, re.match("10-20")[2], re =~ "x 1-2", Regexp.new("a+b").match?("caab"), Regexp.escape("1.5*2"), Regexp.union("a", "b.c")
p "phone: 090-1234-5678".gsub(/(\d{3})-(\d{4})-(\d{4})/, '\1***\3'), "CamelCase".gsub(/([A-Z])/) { "_" + $1.downcase }, "snake_case".gsub(/_(\w)/) { $1.upcase }
p "あいう123".scan(/\p{Hiragana}/), "tel 03".sub(/\s+/, ""), "%-5s|" % "ab", "aaa".gsub(/a/, "b" => "c"), "abab".sub(/b/) { |x| x.upcase }
words = "The quick brown fox".scan(/\w+/)
p words.map(&:length), "email@example.com".match?(/\A[\w.]+@[\w.]+\z/), "a\tb".split(/\s/)
md = /(\w+)@(\w+)/.match("x foo@bar y")
p md, md.post_match, Regexp.last_match(1)
