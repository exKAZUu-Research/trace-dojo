class Counter
  class << self
    def create = new
    attr_accessor :count
  end
  self.count = 0
end
p Counter.create.class, Counter.count
o = Object.new
def o.hello = "hi from o"
p o.hello
class Animal
  def speak = "..."
  alias talk speak
  alias_method :say, :speak
end
p Animal.new.talk, Animal.new.say
class Animal; undef talk; end
begin; Animal.new.talk; rescue NoMethodError => e; p e.message; end
p [1, 2, 3].map { _1 * 2 }, [[1, 2], [3, 4]].map { _1 + _2 }, [5, 6].map { it + 1 }, [[1, 2]].map { _1 }
def target(*args, **kw, &blk) = [args, kw, blk&.call]
def fwd(...) = target(...)
p fwd(1, 2, a: 3) { :blk }
def nokw(a, **nil) = a
begin; nokw(1, b: 2); rescue ArgumentError => e; p e.message; end
p defined?(x), defined?(puts), defined?(String), defined?(@iv), defined?(Nope), defined?(3 + 3)
x = 1
p defined?(x), defined?(@iv = 1)
p 0x1F, 0b1010, 0o17, 017, 1_000, 1e3, 2.5e-3, 6.02e23, ?a, "con" "cat", %w[a b c], %i[x y], :"hello world", {"key": 1}, %q(it's), %Q(v#{x})
p 3r, 1.5r, 1/3r, 2**-2, Rational(3, 6), 0.75.to_r, 1.quo(3), Rational("2/4") + 1, (1/3r).round(2), 3.to_r
t = <<~TEXT
  Dear #{x},
    indented
  bye
TEXT
puts t
u = <<-EOS
    keep
    EOS
p u
v = <<~'RAW'
  no #{interp} \n here
RAW
p v
config = {name: "app", ver: [1, 2], meta: {env: "dev"}}
case config
in {name: String => nm, ver: [major, *], meta: {env:}}
  p [nm, major, env]
end
case [1, [2, 3]]
in [Integer => a, [b, *c]] if a > 0
  p [a, b, c]
end
r = case 7
    in 0 then :zero
    in Integer | Float => n if n > 5 then :big
    else :other
    end
p r
data = {status: "ok", items: [1, 2]}
data => {status:}
p status
p((1 in Integer), ({a: 1} in {a: String}))
case [1, 42, "x", 7]
in [*, String => s, *rest]
  p s, rest
end
pin = 5
case 5
in ^pin then p :pinned
end
begin
  case 99
  in 1 then 0
  end
rescue NoMatchingPatternError => e
  p e.class, e.message
end
Point = Struct.new(:x, :y)
case Point.new(1, 2)
in [x2, y2] then p [x2, y2]
end
case Point.new(1, 2)
in {x:, y:} then p x + y
end
i = 0
[1, 2].each do |v|
  i += 1
  redo if i == 1
  p [v, i]
end
p __LINE__
END { puts "end block" }
at_exit { puts "at exit" }
BEGIN { puts "begin block" }
p DATA.read
__END__
line a
line b
