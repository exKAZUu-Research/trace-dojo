import type { LibrarySource } from '../librarySources';
import { TYPE_INFO } from './typeInfo';
import { TYPE_TRAITS } from './typeTraits';

export const ANY: LibrarySource = {
  names: ['any', 'any_cast', 'make_any'],
  uses: [TYPE_TRAITS, TYPE_INFO],
  source: String.raw`
struct __any_holder_base {
  virtual ~__any_holder_base() {}
  virtual __any_holder_base* __clone() const = 0;
  virtual const type_info& __type() const noexcept = 0;
};
template <class T>
struct __any_holder final : __any_holder_base {
  T __value;
  template <class... Args>
  explicit __any_holder(Args&&... args) : __value(std::forward<Args>(args)...) {}
  __any_holder_base* __clone() const override { return new __any_holder(__value); }
  const type_info& __type() const noexcept override { return typeid(T); }
};

class any {
  __any_holder_base* __held = nullptr;
  void* __buffer[3];

public:
  constexpr any() noexcept {}
  any(const any& other) : __held(other.__held ? other.__held->__clone() : nullptr) {}
  any(any&& other) noexcept : __held(other.__held) { other.__held = nullptr; }
  template <class T>
    requires(!is_same_v<decay_t<T>, any>)
  any(T&& value) : __held(new __any_holder<decay_t<T>>(std::forward<T>(value))) {}
  ~any() { reset(); }

  any& operator=(const any& other) {
    any(other).swap(*this);
    return *this;
  }
  any& operator=(any&& other) noexcept {
    any(std::move(other)).swap(*this);
    return *this;
  }
  template <class T>
    requires(!is_same_v<decay_t<T>, any>)
  any& operator=(T&& value) {
    any(std::forward<T>(value)).swap(*this);
    return *this;
  }

  template <class T, class... Args>
  decay_t<T>& emplace(Args&&... args) {
    reset();
    auto* held = new __any_holder<decay_t<T>>(std::forward<Args>(args)...);
    __held = held;
    return held->__value;
  }
  void reset() noexcept {
    delete __held;
    __held = nullptr;
  }
  void swap(any& other) noexcept {
    __any_holder_base* held = __held;
    __held = other.__held;
    other.__held = held;
  }
  bool has_value() const noexcept { return __held != nullptr; }
  const type_info& type() const noexcept { return __held ? __held->__type() : typeid(void); }
  __any_holder_base* __holder() const noexcept { return __held; }
};

template <class T>
const T* any_cast(const any* a) noexcept {
  if (!a || !a->has_value() || a->type() != typeid(T)) return nullptr;
  return &static_cast<__any_holder<T>*>(a->__holder())->__value;
}
template <class T>
T* any_cast(any* a) noexcept {
  if (!a || !a->has_value() || a->type() != typeid(T)) return nullptr;
  return &static_cast<__any_holder<T>*>(a->__holder())->__value;
}
template <class T>
T any_cast(const any& a) {
  auto* value = any_cast<remove_cvref_t<T>>(&a);
  if (!value) throw std::bad_any_cast();
  return static_cast<T>(*value);
}
template <class T>
T any_cast(any& a) {
  auto* value = any_cast<remove_cvref_t<T>>(&a);
  if (!value) throw std::bad_any_cast();
  return static_cast<T>(*value);
}
template <class T>
T any_cast(any&& a) {
  auto* value = any_cast<remove_cvref_t<T>>(&a);
  if (!value) throw std::bad_any_cast();
  return static_cast<T>(std::move(*value));
}
template <class T, class... Args>
any make_any(Args&&... args) {
  any made;
  made.template emplace<T>(std::forward<Args>(args)...);
  return made;
}
inline void swap(any& a, any& b) noexcept { a.swap(b); }
`,
};
