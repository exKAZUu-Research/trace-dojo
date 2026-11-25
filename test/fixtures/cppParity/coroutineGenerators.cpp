#include <coroutine>
#include <iostream>
#include <string>
#include <utility>

template <class T>
class Generator {
 public:
  struct promise_type {
    T current;
    Generator get_return_object() { return Generator{std::coroutine_handle<promise_type>::from_promise(*this)}; }
    std::suspend_always initial_suspend() noexcept { return {}; }
    std::suspend_always final_suspend() noexcept { return {}; }
    std::suspend_always yield_value(T value) {
      current = std::move(value);
      return {};
    }
    void return_void() {}
    void unhandled_exception() { throw; }
  };
  explicit Generator(std::coroutine_handle<promise_type> h) : handle(h) {}
  Generator(Generator&& other) noexcept : handle(std::exchange(other.handle, {})) {}
  ~Generator() {
    if (handle) handle.destroy();
  }
  bool next() {
    handle.resume();
    return !handle.done();
  }
  T value() const { return handle.promise().current; }

 private:
  std::coroutine_handle<promise_type> handle;
};

struct Noisy {
  std::string name;
  Noisy(std::string n) : name(std::move(n)) { std::cout << "make " << name << "\n"; }
  ~Noisy() { std::cout << "drop " << name << "\n"; }
};

Generator<int> fibonacci(int count) {
  Noisy guard("fib");
  int a = 0, b = 1;
  for (int i = 0; i < count; ++i) {
    co_yield a;
    int next = a + b;
    a = b;
    b = next;
  }
}

Generator<std::string> words() {
  co_yield "alpha";
  {
    Noisy inner("inner");
    co_yield "beta";
  }
  co_yield "gamma";
}

int main() {
  auto fib = fibonacci(8);
  while (fib.next()) std::cout << fib.value() << ' ';
  std::cout << '\n';
  {
    auto w = words();
    w.next();
    std::cout << w.value() << '\n';
    w.next();
    std::cout << w.value() << '\n';
  }
  std::cout << "end\n";
}
