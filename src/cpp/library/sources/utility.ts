import type { LibrarySource } from '../librarySources';
import { TYPE_TRAITS } from './typeTraits';

/** The parts of `<utility>` and `<iterator>` that are plain C++. */
export const UTILITY: LibrarySource = {
  names: [
    'exchange',
    'as_const',
    'cmp_equal',
    'cmp_not_equal',
    'cmp_less',
    'cmp_greater',
    'cmp_less_equal',
    'cmp_greater_equal',
    'default_sentinel_t',
    'default_sentinel',
  ],
  uses: [TYPE_TRAITS],
  source: String.raw`
struct default_sentinel_t {};
inline constexpr default_sentinel_t default_sentinel{};

template <class T, class U = T>
constexpr T exchange(T& object, U&& value) {
  T old = std::move(object);
  object = std::forward<U>(value);
  return old;
}

template <class T>
constexpr const T& as_const(T& value) noexcept {
  return value;
}
template <class T>
void as_const(const T&&) = delete;

template <class T, class U>
constexpr bool cmp_equal(T t, U u) noexcept {
  if constexpr (is_signed_v<T> == is_signed_v<U>) return t == u;
  else if constexpr (is_signed_v<T>) return t >= 0 && make_unsigned_t<T>(t) == u;
  else return u >= 0 && make_unsigned_t<U>(u) == t;
}
template <class T, class U>
constexpr bool cmp_not_equal(T t, U u) noexcept {
  return !cmp_equal(t, u);
}
template <class T, class U>
constexpr bool cmp_less(T t, U u) noexcept {
  if constexpr (is_signed_v<T> == is_signed_v<U>) return t < u;
  else if constexpr (is_signed_v<T>) return t < 0 || make_unsigned_t<T>(t) < u;
  else return u >= 0 && t < make_unsigned_t<U>(u);
}
template <class T, class U>
constexpr bool cmp_greater(T t, U u) noexcept {
  return cmp_less(u, t);
}
template <class T, class U>
constexpr bool cmp_less_equal(T t, U u) noexcept {
  return !cmp_less(u, t);
}
template <class T, class U>
constexpr bool cmp_greater_equal(T t, U u) noexcept {
  return !cmp_less(t, u);
}
`,
};
