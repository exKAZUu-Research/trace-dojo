import type { LibrarySource } from '../librarySources';
import { TYPE_TRAITS } from './typeTraits';

export const OPTIONAL: LibrarySource = {
  names: ['optional', 'nullopt_t', 'nullopt', 'make_optional'],
  uses: [TYPE_TRAITS],
  source: String.raw`
struct nullopt_t {
  explicit constexpr nullopt_t(int) {}
};
inline constexpr nullopt_t nullopt{0};

template <class T>
union __optional_storage {
  char __null;
  T __value;
  constexpr __optional_storage() : __null() {}
  ~__optional_storage() {}
};

template <class T>
class optional {
  __optional_storage<T> __storage;
  bool __engaged = false;

public:
  using value_type = T;

  constexpr optional() noexcept {}
  constexpr optional(nullopt_t) noexcept {}
  optional(const optional& other) {
    if (other.__engaged) __construct(other.__storage.__value);
  }
  optional(optional&& other) {
    if (other.__engaged) __construct(std::move(other.__storage.__value));
  }
  template <class U = T>
    requires(!is_same_v<remove_cvref_t<U>, optional> && !is_same_v<remove_cvref_t<U>, nullopt_t>)
  optional(U&& value) {
    __construct(std::forward<U>(value));
  }
  ~optional() { reset(); }

  optional& operator=(nullopt_t) noexcept {
    reset();
    return *this;
  }
  optional& operator=(const optional& other) {
    if (this == &other) return *this;
    if (!other.__engaged) reset();
    else if (__engaged) __storage.__value = other.__storage.__value;
    else __construct(other.__storage.__value);
    return *this;
  }
  optional& operator=(optional&& other) {
    if (!other.__engaged) reset();
    else if (__engaged) __storage.__value = std::move(other.__storage.__value);
    else __construct(std::move(other.__storage.__value));
    return *this;
  }
  template <class U = T>
    requires(!is_same_v<remove_cvref_t<U>, optional> && !is_same_v<remove_cvref_t<U>, nullopt_t>)
  optional& operator=(U&& value) {
    if (__engaged) __storage.__value = std::forward<U>(value);
    else __construct(std::forward<U>(value));
    return *this;
  }

  template <class... Args>
  T& emplace(Args&&... args) {
    reset();
    __construct(std::forward<Args>(args)...);
    return __storage.__value;
  }
  void reset() noexcept {
    if (__engaged) {
      __storage.__value.~T();
      __engaged = false;
    }
  }
  void swap(optional& other) {
    if (__engaged && other.__engaged) {
      T moved = std::move(__storage.__value);
      __storage.__value = std::move(other.__storage.__value);
      other.__storage.__value = std::move(moved);
    } else if (__engaged) {
      other.__construct(std::move(__storage.__value));
      reset();
    } else if (other.__engaged) {
      __construct(std::move(other.__storage.__value));
      other.reset();
    }
  }

  constexpr bool has_value() const noexcept { return __engaged; }
  constexpr explicit operator bool() const noexcept { return __engaged; }

  T& value() & {
    if (!__engaged) throw std::bad_optional_access();
    return __storage.__value;
  }
  const T& value() const& {
    if (!__engaged) throw std::bad_optional_access();
    return __storage.__value;
  }
  T&& value() && {
    if (!__engaged) throw std::bad_optional_access();
    return std::move(__storage.__value);
  }
  template <class U>
  T value_or(U&& fallback) const& {
    return __engaged ? __storage.__value : static_cast<T>(std::forward<U>(fallback));
  }
  template <class U>
  T value_or(U&& fallback) && {
    return __engaged ? std::move(__storage.__value) : static_cast<T>(std::forward<U>(fallback));
  }

  T& operator*() & { return __storage.__value; }
  const T& operator*() const& { return __storage.__value; }
  T&& operator*() && { return std::move(__storage.__value); }
  T* operator->() { return &__storage.__value; }
  const T* operator->() const { return &__storage.__value; }

private:
  template <class... Args>
  void __construct(Args&&... args) {
    new (&__storage.__value) T(std::forward<Args>(args)...);
    __engaged = true;
  }
};

template <class T>
optional(T) -> optional<T>;

template <class T>
optional<decay_t<T>> make_optional(T&& value) {
  return optional<decay_t<T>>(std::forward<T>(value));
}
template <class T, class... Args>
optional<T> make_optional(Args&&... args) {
  optional<T> made;
  made.emplace(std::forward<Args>(args)...);
  return made;
}

template <class T> inline constexpr bool __is_optional = false;
template <class T> inline constexpr bool __is_optional<optional<T>> = true;

template <class T, class U>
bool operator==(const optional<T>& a, const optional<U>& b) {
  if (a.has_value() != b.has_value()) return false;
  return !a.has_value() || *a == *b;
}
template <class T, class U>
bool operator!=(const optional<T>& a, const optional<U>& b) { return !(a == b); }
template <class T, class U>
bool operator<(const optional<T>& a, const optional<U>& b) {
  if (!b.has_value()) return false;
  return !a.has_value() || *a < *b;
}
template <class T, class U>
bool operator>(const optional<T>& a, const optional<U>& b) { return b < a; }
template <class T, class U>
bool operator<=(const optional<T>& a, const optional<U>& b) { return !(b < a); }
template <class T, class U>
bool operator>=(const optional<T>& a, const optional<U>& b) { return !(a < b); }

template <class T>
bool operator==(const optional<T>& a, nullopt_t) noexcept { return !a.has_value(); }
template <class T>
bool operator!=(const optional<T>& a, nullopt_t) noexcept { return a.has_value(); }

template <class T, class U>
  requires(!__is_optional<U> && requires(const T& t, const U& u) { t == u; })
bool operator==(const optional<T>& a, const U& b) { return a.has_value() && *a == b; }
template <class T, class U>
  requires(!__is_optional<U> && requires(const T& t, const U& u) { t == u; })
bool operator!=(const optional<T>& a, const U& b) { return !(a == b); }
template <class T, class U>
  requires(!__is_optional<U> && requires(const T& t, const U& u) { t < u; })
bool operator<(const optional<T>& a, const U& b) { return !a.has_value() || *a < b; }
template <class T, class U>
  requires(!__is_optional<U> && requires(const T& t, const U& u) { u < t; })
bool operator>(const optional<T>& a, const U& b) { return a.has_value() && b < *a; }

template <class T>
void swap(optional<T>& a, optional<T>& b) { a.swap(b); }
`,
};
