class MyError < StandardError
  def initialize(msg = "my default")
    super
  end
end
class OtherError < MyError; end
begin
  raise MyError
rescue MyError => e
  p e, e.message, e.class, e.class.superclass
end
begin
  raise OtherError, "custom"
rescue MyError => e
  p e
end
def risky(n)
  raise ArgumentError, "negative" if n < 0
  Math.sqrt(n)
ensure
  puts "ensure #{n}"
end
p risky(4)
begin
  risky(-1)
rescue ArgumentError, TypeError => e
  puts "caught #{e.message}"
else
  puts "no error"
ensure
  puts "finally"
end
x = begin
  Integer("12")
rescue
  0
else
  99
end
p x
y = Integer("zz") rescue -1
p y
attempts = 0
begin
  attempts += 1
  raise "fail" if attempts < 3
  puts "ok after #{attempts}"
rescue
  retry
end
begin
  begin
    1 / 0
  rescue ZeroDivisionError => e
    raise RuntimeError, "wrapped"
  end
rescue => e
  p e.message, e.cause
end
e = RuntimeError.new("boom")
p e.message
begin; raise e; rescue => err; p err.equal?(e); end
begin
  raise "plain"
rescue StandardError => err
  p err.class
end
def m
  yield
rescue LocalJumpError => e
  p e.message
end
m
begin; [].fetch(3); rescue IndexError => e; p e.message; end
begin; {a: 1}.fetch(:z); rescue KeyError => e; p e.message, e.key, e.receiver; end
begin; raise TypeError.new("t"); rescue => e; p e; end
p((raise "x" rescue $!.message))
begin; raise Exception, "base"; rescue StandardError; p 1; rescue Exception => e; p e; end
begin; 1.upto; rescue => e; p e; end
v = [1, 2].each do |i|
  begin
    raise "in" if i == 1
  rescue
    next
  end
  p i
end
catch(:done) do
  10.times { |i| throw :done if i == 3; p i }
end
p catch { |tag| throw tag, 5 }
begin; throw :nope; rescue UncaughtThrowError => e; p e.message; end
raise MyError
