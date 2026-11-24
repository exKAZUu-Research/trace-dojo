import type { LibrarySource } from '../librarySources';
import { TYPE_TRAITS } from './typeTraits';

export const FUNCTION: LibrarySource = {
  names: ['function'],
  uses: [TYPE_TRAITS],
  source: String.raw`
template <class R, class... Args>
struct __callable {
  virtual ~__callable() {}
  virtual R __call(Args... args) = 0;
  virtual __callable* __clone() const = 0;
  // libc++ keeps a small callable that copies without throwing in its own buffer, which a move copies.
  virtual bool __is_small() const = 0;
};

template <class F, class R, class... Args>
struct __callable_of final : __callable<R, Args...> {
  F __f;
  explicit __callable_of(const F& f) : __f(f) {}
  explicit __callable_of(F&& f) : __f(std::move(f)) {}
  R __call(Args... args) override { return __f(std::forward<Args>(args)...); }
  __callable<R, Args...>* __clone() const override { return new __callable_of(__f); }
  bool __is_small() const override { return sizeof(F) <= 3 * sizeof(void*) && is_trivially_copyable_v<F>; }
};

template <class>
class function;

template <class R, class... Args>
class function<R(Args...)> {
  __callable<R, Args...>* __target = nullptr;
  void* __buffer[3];

public:
  using result_type = R;

  function() noexcept {}
  function(nullptr_t) noexcept {}
  function(const function& other) : __target(other.__target ? other.__target->__clone() : nullptr) {}
  function(function&& other) noexcept : __target(other.__target) {
    if (__target && __target->__is_small()) __target = __target->__clone();
    else other.__target = nullptr;
  }
  template <class F>
    requires(!is_same_v<remove_cvref_t<F>, function> && is_invocable_v<F&, Args...>)
  function(F f) : __target(new __callable_of<F, R, Args...>(std::move(f))) {}
  ~function() { delete __target; }

  function& operator=(const function& other) {
    function(other).swap(*this);
    return *this;
  }
  function& operator=(function&& other) noexcept {
    function(std::move(other)).swap(*this);
    return *this;
  }
  function& operator=(nullptr_t) noexcept {
    delete __target;
    __target = nullptr;
    return *this;
  }
  template <class F>
    requires(!is_same_v<remove_cvref_t<F>, function> && is_invocable_v<F&, Args...>)
  function& operator=(F&& f) {
    function(std::forward<F>(f)).swap(*this);
    return *this;
  }

  void swap(function& other) noexcept {
    __callable<R, Args...>* target = __target;
    __target = other.__target;
    other.__target = target;
  }
  explicit operator bool() const noexcept { return __target != nullptr; }
  R operator()(Args... args) const {
    if (!__target) throw std::bad_function_call();
    return __target->__call(std::forward<Args>(args)...);
  }
};

template <class R, class... Args>
function(R (*)(Args...)) -> function<R(Args...)>;

template <class R, class... Args>
bool operator==(const function<R(Args...)>& f, nullptr_t) noexcept { return !f; }
template <class R, class... Args>
bool operator!=(const function<R(Args...)>& f, nullptr_t) noexcept { return static_cast<bool>(f); }
template <class R, class... Args>
void swap(function<R(Args...)>& a, function<R(Args...)>& b) noexcept { a.swap(b); }
`,
};
