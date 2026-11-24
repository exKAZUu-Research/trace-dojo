#include <coroutine>
#include <exception>
#include <iostream>
#include <string>
#include <vector>

template <class T>
class Generator {
 public:
  struct promise_type {
    const T* current = nullptr;
    Generator get_return_object() { return Generator{Handle::from_promise(*this)}; }
    std::suspend_always initial_suspend() noexcept { return {}; }
    std::suspend_always final_suspend() noexcept { return {}; }
    std::suspend_always yield_value(const T& value) noexcept {
      current = &value;
      return {};
    }
    void return_void() noexcept {}
    void unhandled_exception() { throw; }
  };
  using Handle = std::coroutine_handle<promise_type>;

  struct iterator {
    Handle handle;
    iterator& operator++() {
      handle.resume();
      return *this;
    }
    const T& operator*() const { return *handle.promise().current; }
    bool operator==(std::default_sentinel_t) const { return !handle || handle.done(); }
  };

  explicit Generator(Handle h) : handle_(h) {}
  Generator(const Generator&) = delete;
  Generator(Generator&& other) noexcept : handle_(other.handle_) { other.handle_ = nullptr; }
  ~Generator() {
    if (handle_) handle_.destroy();
  }
  iterator begin() {
    handle_.resume();
    return iterator{handle_};
  }
  std::default_sentinel_t end() { return {}; }

 private:
  Handle handle_;
};

struct Tracer {
  std::string name;
  explicit Tracer(std::string n) : name(std::move(n)) { std::cout << "+" << name << "\n"; }
  ~Tracer() { std::cout << "-" << name << "\n"; }
};

Generator<std::string> split(std::string text, char separator) {
  Tracer t("split");
  std::string word;
  for (char c : text) {
    if (c == separator) {
      if (!word.empty()) co_yield word;
      word.clear();
    } else {
      word += c;
    }
  }
  if (!word.empty()) co_yield word;
}

Generator<int> range(int from, int to, int step = 1) {
  for (int i = from; i < to; i += step) co_yield i;
}

Generator<int> faulty() {
  co_yield 1;
  throw std::runtime_error("bad value");
}

struct Counter {
  int base;
  Generator<int> multiples(int n) {
    for (int i = 1; i <= n; ++i) co_yield base * i;
  }
};

int main() {
  for (const auto& w : split("the quick  brown fox", ' ')) std::cout << "[" << w << "]\n";
  int total = 0;
  for (int x : range(0, 10, 3)) total += x;
  std::cout << "total " << total << "\n";
  for (int x : range(0, 100)) {
    if (x == 2) break;
    std::cout << x << "\n";
  }
  try {
    for (int x : faulty()) std::cout << "got " << x << "\n";
  } catch (const std::exception& e) {
    std::cout << "error: " << e.what() << "\n";
  }
  Counter c{7};
  for (int m : c.multiples(3)) std::cout << m << " ";
  std::cout << "\n";
  auto lambda = [](int n) -> Generator<int> {
    for (int i = n; i > 0; --i) co_yield i * i;
  };
  for (int v : lambda(4)) std::cout << v << " ";
  std::cout << "\n";
  std::vector<std::string> collected;
  {
    auto g = split("a,b,c", ',');
    auto it = g.begin();
    collected.push_back(*it);
    ++it;
    collected.push_back(*it);
  }
  std::cout << collected.size() << collected[0] << collected[1] << "\n";
}
