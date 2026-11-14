x = 5
if x > 3 then puts "big" end
if x > 10
  puts "huge"
elsif x > 4
  puts "medium"
else
  puts "small"
end
unless x == 5 then puts "not five" else puts "five" end
puts "pos" if x.positive?
puts "neg" unless x.positive?
y = if x.even? then "even" else "odd" end
p y
z = x > 2 ? "yes" : "no"
p z
i = 0
i += 1 while i < 10
p i
j = 10
j -= 3 until j < 0
p j
k = 0
begin
  k += 1
end while k < 0
p k
for a in 1..3 do print a, " " end
puts
p a
for b, c in [[1, 2], [3, 4]]
  p [b, c]
end
r = [1, 2, 3].each do |v|
  next if v == 2
  puts v
end
p r
w = [1, 2, 3, 4].each { |v| break v * 10 if v == 3 }
p w
n = 0
res = while n < 5
  n += 1
  break n * 2 if n == 3
end
p res
p (while false do end)
case 7
when Integer then puts "int"
end
case "b"
when "a", "b" then puts "ab"
end
case
when x < 3 then puts "lt3"
when x < 6 then puts "lt6"
end
v = case 3 when 1 then :one when 3 then :three end
p v
p (1 if false)
loop do
  n += 1
  break if n > 6
end
p n
p (not true), (true and false), (nil or 2), (1 && nil), (false || :x)
p [1,2,3].each_with_index.map { |v, i| v * i }
