#include <coroutine>
#include <iostream>
#include <string>
#include <vector>

struct Task {
  struct promise_type {
    std::vector<std::string> log;
    Task get_return_object() { return Task{std::coroutine_handle<promise_type>::from_promise(*this)}; }
    std::suspend_never initial_suspend() noexcept { return {}; }
    std::suspend_always final_suspend() noexcept { return {}; }
    void return_void() { std::cout << "return_void\n"; }
    void unhandled_exception() {}
    // await_transform turns an int into a ready awaiter that doubles it.
    struct Doubler {
      int v;
      bool await_ready() { return true; }
      void await_suspend(std::coroutine_handle<>) {}
      int await_resume() { return v * 2; }
    };
    Doubler await_transform(int v) { return {v}; }
    template <class A>
    A&& await_transform(A&& a) {
      return static_cast<A&&>(a);
    }
  };
  std::coroutine_handle<promise_type> h;
};

struct Pause {
  int id;
  bool await_ready() const { return false; }
  bool await_suspend(std::coroutine_handle<> h) {
    std::cout << "suspend? " << id << "\n";
    return id % 2 == 0;
  }
  std::string await_resume() { return "resumed " + std::to_string(id); }
};

struct Wrapper {
  int id;
};
Pause operator co_await(Wrapper w) { return Pause{w.id * 10}; }

struct Member {
  struct Awaiter {
    bool await_ready() { return true; }
    void await_suspend(std::coroutine_handle<>) {}
    int& await_resume() { return *target; }
    int* target;
  };
  int value = 5;
  Awaiter operator co_await() { return Awaiter{&value}; }
};

std::coroutine_handle<> saved;

Task run() {
  int a = co_await 21;
  std::cout << "a=" << a << "\n";
  std::string s1 = co_await Pause{1};
  std::cout << s1 << "\n";
  std::cout << "before " << co_await Pause{2} << " after\n";
  std::cout << co_await Wrapper{3} << "\n";
  Member m;
  co_await m += 1;
  std::cout << "m.value=" << m.value << "\n";
  if (co_await 3 > 5) std::cout << "big\n";
  int sum = co_await 1 + co_await 2;
  std::cout << "sum=" << sum << "\n";
}

int main() {
  Task t = run();
  std::cout << "main: suspended, done=" << t.h.done() << "\n";
  while (!t.h.done()) {
    t.h.resume();
    std::cout << "main: done=" << t.h.done() << "\n";
  }
  t.h.destroy();
}
