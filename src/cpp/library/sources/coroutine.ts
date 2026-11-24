import type { LibrarySource } from '../librarySources';

/**
 * `<coroutine>`. A handle's address is the address of its coroutine's promise, which the interpreter's natives
 * (`__builtin_coro_resume` and the others) map to the coroutine.
 */
export const COROUTINE: LibrarySource = {
  names: [
    'coroutine_traits',
    'coroutine_handle',
    'noop_coroutine',
    'noop_coroutine_handle',
    'noop_coroutine_promise',
    'suspend_always',
    'suspend_never',
  ],
  source: String.raw`
template <class R, class... Args>
struct coroutine_traits {
  using promise_type = typename R::promise_type;
};

template <class P = void>
struct coroutine_handle;

template <>
struct coroutine_handle<void> {
  void* __address = nullptr;

  constexpr coroutine_handle() noexcept {}
  constexpr coroutine_handle(decltype(nullptr)) noexcept {}
  coroutine_handle& operator=(decltype(nullptr)) noexcept {
    __address = nullptr;
    return *this;
  }
  constexpr void* address() const noexcept { return __address; }
  static constexpr coroutine_handle from_address(void* address) noexcept {
    coroutine_handle handle;
    handle.__address = address;
    return handle;
  }
  constexpr explicit operator bool() const noexcept { return __address != nullptr; }
  bool done() const { return std::__builtin_coro_done(__address); }
  void operator()() const { resume(); }
  void resume() const { std::__builtin_coro_resume(__address); }
  void destroy() const { std::__builtin_coro_destroy(__address); }
};

template <class P>
struct coroutine_handle {
  void* __address = nullptr;

  constexpr coroutine_handle() noexcept {}
  constexpr coroutine_handle(decltype(nullptr)) noexcept {}
  coroutine_handle& operator=(decltype(nullptr)) noexcept {
    __address = nullptr;
    return *this;
  }
  static coroutine_handle from_promise(P& promise) {
    coroutine_handle handle;
    handle.__address = static_cast<void*>(&promise);
    return handle;
  }
  static constexpr coroutine_handle from_address(void* address) noexcept {
    coroutine_handle handle;
    handle.__address = address;
    return handle;
  }
  constexpr void* address() const noexcept { return __address; }
  constexpr operator coroutine_handle<>() const noexcept { return coroutine_handle<>::from_address(__address); }
  constexpr explicit operator bool() const noexcept { return __address != nullptr; }
  bool done() const { return std::__builtin_coro_done(__address); }
  void operator()() const { resume(); }
  void resume() const { std::__builtin_coro_resume(__address); }
  void destroy() const { std::__builtin_coro_destroy(__address); }
  P& promise() const { return *static_cast<P*>(__address); }
};

inline bool operator==(coroutine_handle<> a, coroutine_handle<> b) noexcept { return a.address() == b.address(); }
inline bool operator!=(coroutine_handle<> a, coroutine_handle<> b) noexcept { return a.address() != b.address(); }
inline bool operator<(coroutine_handle<> a, coroutine_handle<> b) noexcept { return a.address() < b.address(); }
inline bool operator>(coroutine_handle<> a, coroutine_handle<> b) noexcept { return a.address() > b.address(); }
inline bool operator<=(coroutine_handle<> a, coroutine_handle<> b) noexcept { return a.address() <= b.address(); }
inline bool operator>=(coroutine_handle<> a, coroutine_handle<> b) noexcept { return a.address() >= b.address(); }

struct noop_coroutine_promise {};
using noop_coroutine_handle = coroutine_handle<noop_coroutine_promise>;
inline noop_coroutine_promise __noop_promise;
inline noop_coroutine_handle noop_coroutine() noexcept {
  return noop_coroutine_handle::from_promise(__noop_promise);
}

struct suspend_always {
  constexpr bool await_ready() const noexcept { return false; }
  constexpr void await_suspend(coroutine_handle<>) const noexcept {}
  constexpr void await_resume() const noexcept {}
};
struct suspend_never {
  constexpr bool await_ready() const noexcept { return true; }
  constexpr void await_suspend(coroutine_handle<>) const noexcept {}
  constexpr void await_resume() const noexcept {}
};
`,
};
