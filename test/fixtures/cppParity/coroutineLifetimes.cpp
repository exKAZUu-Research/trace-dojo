#include <coroutine>
#include <iostream>
#include <stdexcept>
#include <string>

struct Noisy {
  std::string name;
  Noisy(std::string n) : name(std::move(n)) { std::cout << "ctor " << name << "\n"; }
  Noisy(const Noisy& o) : name(o.name + "'") { std::cout << "copy " << name << "\n"; }
  Noisy(Noisy&& o) noexcept : name(o.name + "~") { std::cout << "move " << name << "\n"; }
  ~Noisy() { std::cout << "dtor " << name << "\n"; }
};

struct Eager {
  struct promise_type {
    Eager get_return_object() { return {}; }
    std::suspend_never initial_suspend() noexcept { return {}; }
    std::suspend_never final_suspend() noexcept { return {}; }
    void return_void() {}
    void unhandled_exception() { throw; }
    ~promise_type() { std::cout << "promise gone\n"; }
  };
};

Eager eager(Noisy n, int fail) {
  std::cout << "eager body " << n.name << "\n";
  if (fail) throw std::runtime_error("eager failure");
  co_return;
}

struct Lazy {
  struct promise_type {
    Lazy get_return_object() { return Lazy{std::coroutine_handle<promise_type>::from_promise(*this)}; }
    std::suspend_always initial_suspend() noexcept { return {}; }
    std::suspend_always final_suspend() noexcept { return {}; }
    void return_void() {}
    void unhandled_exception() { std::cout << "unhandled\n"; }
  };
  std::coroutine_handle<promise_type> h;
};

Lazy lazy(Noisy n) {
  Noisy local("local");
  try {
    std::cout << "in try\n";
    co_await std::suspend_always{};
    std::cout << "after first\n";
    throw std::logic_error("inside");
  } catch (const std::logic_error& e) {
    std::cout << "caught " << e.what() << "\n";
  }
  {
    Noisy inner("inner");
    co_await std::suspend_always{};
    std::cout << "never\n";
  }
}

Lazy thrower() {
  co_await std::suspend_always{};
  throw 42;
}

int main() {
  eager(Noisy("a"), 0);
  try {
    eager(Noisy("b"), 1);
  } catch (const std::exception& e) {
    std::cout << "main caught " << e.what() << "\n";
  }
  Lazy l = lazy(Noisy("p"));
  std::cout << "created\n";
  l.h.resume();
  std::cout << "resumed once\n";
  try {
    l.h.resume();
  } catch (...) {
    std::cout << "should not reach\n";
  }
  std::cout << "resumed twice, done=" << l.h.done() << "\n";
  l.h.destroy();
  std::cout << "destroyed\n";
  Lazy t = thrower();
  t.h.resume();
  t.h.resume();
  std::cout << "thrower done=" << t.h.done() << "\n";
  t.h.destroy();
  std::coroutine_handle<> none = nullptr;
  std::coroutine_handle<> noop = std::noop_coroutine();
  noop.resume();
  noop();
  std::cout << (none == nullptr) << (noop != none) << static_cast<bool>(noop) << noop.done() << "\n";
  auto copy = std::coroutine_handle<>::from_address(noop.address());
  std::cout << (copy == noop) << "\n";
}
