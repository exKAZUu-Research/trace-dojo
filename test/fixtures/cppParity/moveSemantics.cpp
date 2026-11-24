#include <iostream>
#include <string>
#include <vector>
#include <utility>
struct Buffer {
  std::vector<int> data;
  std::string name;
  Buffer(std::string n, int size) : data(size, 1), name(std::move(n)) {}
  Buffer(const Buffer& o) : data(o.data), name(o.name + "-copy") { std::cout << "copy\n"; }
  Buffer(Buffer&& o) noexcept : data(std::move(o.data)), name(std::move(o.name)) { std::cout << "move\n"; }
  Buffer& operator=(Buffer&& o) noexcept { data = std::move(o.data); name = std::move(o.name); std::cout << "move-assign\n"; return *this; }
  Buffer& operator=(const Buffer& o) { data = o.data; name = o.name; std::cout << "copy-assign\n"; return *this; }
};
void take(std::string&& s) { std::cout << "rvalue " << s << "\n"; }
void take(const std::string& s) { std::cout << "lvalue " << s << "\n"; }
template <class T> void relay(T&& x) { take(std::forward<T>(x)); }
Buffer make() { return Buffer("made", 2); }
int main() {
  Buffer a("a", 3);
  Buffer b = a;
  Buffer c = std::move(a);
  std::cout << a.data.size() << "[" << a.name << "] " << c.data.size() << c.name << "\n";
  b = std::move(c);
  b = a;
  std::string s = "hi";
  take(s); take(std::move(s)); take(std::string("tmp"));
  relay(s); relay(std::string("fw"));
  int&& r = 5;
  r += 1;
  std::cout << r << "\n";
  auto&& f = b;
  auto&& g = 3;
  f.name = "via f";
  std::cout << b.name << g << "\n";
  std::vector<std::string> v;
  std::string t = "moved";
  v.push_back(std::move(t));
  std::cout << v[0] << "[" << t << "]\n";
  Buffer m = make();
  std::cout << m.name << "\n";
}
