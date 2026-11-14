t = Time.new(2024, 3, 9, 14, 5, 7)
p t, t.year, t.month, t.day, t.hour, t.min, t.sec, t.wday, t.yday, t.zone, t.utc_offset
puts t, t.to_s, t.inspect
p t.strftime("%Y-%m-%d %H:%M:%S"), t.strftime("%y/%-m/%-d %I:%M %p %A %a %B %b %j %%"), t.strftime("%F %T %e %l %L %z %Z %s %u %w %H%M")
u = t + 3600 * 24 + 0.5
p u, u - t, (u - t).class, t < u, t == Time.new(2024, 3, 9, 14, 5, 7), u.usec
p Time.at(0), Time.at(1_700_000_000), Time.at(1_700_000_000).to_i, t.to_a rescue p $!
p Time.new(2024, 2, 29).yday, Time.new(2024, 12, 31).yday, Time.new(2023, 1, 1).wday, t.monday?, t.saturday?
d1 = Time.new(2024, 1, 1)
d2 = Time.new(2024, 12, 25)
p ((d2 - d1) / 86400).to_i, d1.to_f, Time.mktime(2020, 5, 5) rescue p $!
x = Time.now
p x.class, x.year >= 2024, (Time.now - x) < 1.0
p sleep(0), Time.new(2024, 1, 1, 0, 0, 0, "+00:00"), Time.utc(2024, 1, 1), Time.gm(2000, 6, 1, 12).hour
p t.round rescue p $!
