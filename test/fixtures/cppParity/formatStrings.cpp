#include <format>
#include <iostream>
#include <string>
#include <string_view>
int main() {
  std::cout << std::format("Hello, {}! You are {} years old.", "Alice", 30) << "\n";
  std::cout << std::format("{1} {0} {1}", "a", "b") << "\n";
  std::cout << std::format("[{:>8}] [{:<8}] [{:^8}] [{:*^9}]", 42, "left", "mid", "c") << "\n";
  std::cout << std::format("{:08.3f} {:+d} {: d} {:#x} {:#o} {:#b} {:X}", 3.14159, 7, 7, 255, 8, 5, 48879) << "\n";
  std::cout << std::format("{} {} {} {} {}", 0.1, 1e20, 1234567.0, 1e-5, 123.456) << "\n";
  std::cout << std::format("{} {} {} {}", 0.001, 0.0001, 1e21, 100000.0) << "\n";
  std::cout << std::format("{:.2} {:.3e} {:g} {:G} {:.10g} {:a}", 3.14159, 12345.678, 1e-7, 2.5e10, 1.0 / 3, 1.0) << "\n";
  std::cout << std::format("{} {} {} {}", 1.5f, 0.1f, 3.4e38f, -0.0) << "\n";
  std::cout << std::format("{} {:d} {:s} {}", true, false, true, 'x') << "\n";
  std::cout << std::format("{:{}} | {:.{}f} | {:>{}}", 7, 5, 2.71828, 2, "r", 4) << "\n";
  std::string name = "Bob";
  std::string_view sv = "view";
  std::cout << std::format("{:10}|{:.2}|{}", name, sv, std::string("tmp")) << "\n";
  std::cout << std::format("{{literal}} {}%", 50) << "\n";
  std::cout << std::format("{:c}{:c}", 72, 105) << " " << std::format("{:d}", 'A') << "\n";
  std::cout << std::format("[{:6}] [{:<6}] [{:06}]", -42, -42, -42) << "\n";
  std::cout << std::format("[{:>6}]", "日本") << std::format("[{:^7}]", "語") << "\n";
  std::cout << std::formatted_size("{}-{}", 123, "ab") << "\n";
  std::string runtime = "{} + {} = {}";
  int a = 2, b = 3, c = a + b;
  std::cout << std::vformat(runtime, std::make_format_args(a, b, c)) << "\n";
  try {
    std::string bad = "{:d}";
    std::string s = "x";
    std::cout << std::vformat(bad, std::make_format_args(s));
  } catch (const std::format_error& e) {
    std::cout << "format_error\n";
  }
  std::cout << std::format("{:e} {:.0f} {:.1f} {}", 0.0, 2.5, 0.05, 1e100) << "\n";
  std::cout << std::format("{} {}", 18446744073709551615ull, -9223372036854775807ll - 1) << "\n";
}
