#include <coroutine>
#include <iostream>
#include <optional>
#include <string>
struct Token {
  std::string name;
  Token(std::string n) : name(std::move(n)) {}
  ~Token() { std::cout << "~" << name << "\n"; }
};
struct Source {
  int left;
  struct Next {
    Source* s;
    bool await_ready() { return false; }
    void await_suspend(std::coroutine_handle<>) { std::cout << "waiting\n"; }
    std::optional<int> await_resume() {
      if (s->left == 0) return std::nullopt;
      return s->left--;
    }
  };
  Next next() { return Next{this}; }
};
struct Task {
  struct promise_type {
    Task get_return_object() { return Task{std::coroutine_handle<promise_type>::from_promise(*this)}; }
    std::suspend_never initial_suspend() noexcept { return {}; }
    std::suspend_always final_suspend() noexcept { return {}; }
    void return_void() {}
    void unhandled_exception() {}
  };
  std::coroutine_handle<promise_type> h;
};
Task consume(Source& source) {
  int sum = 0;
  while (auto value = co_await source.next()) {
    Token t("iteration " + std::to_string(*value));
    sum += *value;
  }
  std::cout << "sum " << sum << "\n";
}
int main() {
  Source source{3};
  Task t = consume(source);
  while (!t.h.done()) {
    std::cout << "resume\n";
    t.h.resume();
  }
  t.h.destroy();
}
