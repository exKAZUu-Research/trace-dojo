#include <algorithm>
#include <iostream>
#include <map>
#include <ranges>
#include <string>
#include <vector>
struct Person {
  std::string name;
  int age;
};
int main() {
  std::vector<int> v{5, 3, 8, 1, 9, 2, 7};
  for (int x : v | std::views::filter([](int n) { return n % 2 == 1; }) | std::views::transform([](int n) { return n * n; }))
    std::cout << x << " ";
  std::cout << "\n";
  for (int x : std::views::iota(1, 6)) std::cout << x;
  std::cout << "\n";
  for (int x : std::views::iota(10) | std::views::take(3)) std::cout << x << ",";
  std::cout << "\n";
  for (int x : v | std::views::reverse | std::views::drop(2)) std::cout << x;
  std::cout << "\n";
  for (int x : v | std::views::take_while([](int n) { return n != 1; })) std::cout << x;
  std::cout << " | ";
  for (int x : v | std::views::drop_while([](int n) { return n != 1; })) std::cout << x;
  std::cout << "\n";
  std::map<std::string, int> m{{"a", 1}, {"b", 2}};
  for (const auto& k : m | std::views::keys) std::cout << k;
  for (int value : std::views::values(m)) std::cout << value;
  std::cout << "\n";
  std::ranges::sort(v);
  for (int x : v) std::cout << x;
  std::cout << "\n";
  std::ranges::sort(v, std::ranges::greater{});
  for (int x : v) std::cout << x;
  std::cout << "\n";
  std::vector<Person> people{{"Ann", 31}, {"Bob", 25}, {"Cy", 40}};
  std::ranges::sort(people, {}, &Person::age);
  for (const auto& p : people) std::cout << p.name << p.age << " ";
  std::cout << "\n";
  auto it = std::ranges::find(v, 8);
  std::cout << (it != v.end()) << *it << " " << std::ranges::count_if(v, [](int n) { return n > 4; }) << "\n";
  std::cout << std::ranges::max(v) << std::ranges::min(v) << std::ranges::max_element(people, {}, &Person::age)->name << "\n";
  std::cout << std::ranges::all_of(v, [](int n) { return n > 0; }) << "\n";
  auto evens = v | std::views::filter([](int n) { return n % 2 == 0; });
  std::vector<int> out;
  std::ranges::copy(evens, std::back_inserter(out));
  std::cout << out.size() << out[0] << "\n";
  std::ranges::for_each(std::views::iota(0, 3), [](int i) { std::cout << i * 10 << ";"; });
  std::cout << "\n";
  auto pipeline = std::views::filter([](int n) { return n > 2; }) | std::views::transform([](int n) { return n + 100; });
  for (int x : v | pipeline) std::cout << x << " ";
  std::cout << "\n";
  std::ranges::reverse(v);
  for (int x : v) std::cout << x;
  std::cout << "\n";
}
