#include <coroutine>
#include <exception>
#include <iostream>
#include <stdexcept>
#include <utility>

template <class T>
struct Task {
  struct promise_type {
    T value{};
    std::exception_ptr error;
    std::coroutine_handle<> continuation = std::noop_coroutine();
    Task get_return_object() { return Task{std::coroutine_handle<promise_type>::from_promise(*this)}; }
    std::suspend_always initial_suspend() noexcept { return {}; }
    struct FinalAwaiter {
      bool await_ready() noexcept { return false; }
      std::coroutine_handle<> await_suspend(std::coroutine_handle<promise_type> h) noexcept {
        return h.promise().continuation;
      }
      void await_resume() noexcept {}
    };
    FinalAwaiter final_suspend() noexcept { return {}; }
    void return_value(T v) { value = v; }
    void unhandled_exception() { error = std::current_exception(); }
  };
  std::coroutine_handle<promise_type> handle;
  explicit Task(std::coroutine_handle<promise_type> h) : handle(h) {}
  Task(Task&& other) noexcept : handle(std::exchange(other.handle, {})) {}
  ~Task() {
    if (handle) handle.destroy();
  }
  bool await_ready() { return false; }
  std::coroutine_handle<> await_suspend(std::coroutine_handle<> caller) {
    handle.promise().continuation = caller;
    return handle;
  }
  T await_resume() {
    if (handle.promise().error) std::rethrow_exception(handle.promise().error);
    return handle.promise().value;
  }
  T run() {
    handle.resume();
    return await_resume();
  }
};

Task<int> square(int x) {
  std::cout << "square " << x << "\n";
  co_return x * x;
}

Task<int> fails() {
  throw std::runtime_error("boom");
  co_return 0;
}

Task<int> sum() {
  int total = 0;
  for (int i = 1; i <= 3; ++i) total += co_await square(i);
  int s = co_await square(10);
  std::cout << "s=" << s << "\n";
  try {
    co_await fails();
  } catch (const std::exception& e) {
    std::cout << "caught " << e.what() << "\n";
  }
  co_return total + s;
}

struct Ready {
  bool await_ready() { return true; }
  void await_suspend(std::coroutine_handle<>) {}
  int await_resume() { return 7; }
};

Task<int> immediate() {
  int v = co_await Ready{};
  if (co_await Ready{} == 7) std::cout << "seven\n";
  co_return v;
}

int main() {
  std::cout << sum().run() << "\n";
  std::cout << immediate().run() << "\n";
  std::coroutine_handle<> none;
  std::cout << std::boolalpha << static_cast<bool>(none) << "\n";
}
