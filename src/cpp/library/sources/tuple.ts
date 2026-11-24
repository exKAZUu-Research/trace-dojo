import type { LibrarySource } from '../librarySources';
import { TYPE_TRAITS } from './typeTraits';

export const INTEGER_SEQUENCE: LibrarySource = {
  names: ['integer_sequence', 'index_sequence', 'make_integer_sequence', 'make_index_sequence', 'index_sequence_for'],
  source: String.raw`
template <class T, T... I>
struct integer_sequence {
  using value_type = T;
  static constexpr unsigned long size() noexcept { return sizeof...(I); }
};
template <unsigned long... I>
using index_sequence = integer_sequence<unsigned long, I...>;

template <class T, T N, T... I>
struct __make_sequence : __make_sequence<T, N - 1, N - 1, I...> {};
template <class T, T... I>
struct __make_sequence<T, 0, I...> {
  using type = integer_sequence<T, I...>;
};
template <class T, T N>
using make_integer_sequence = typename __make_sequence<T, N>::type;
template <unsigned long N>
using make_index_sequence = make_integer_sequence<unsigned long, N>;
template <class... T>
using index_sequence_for = make_index_sequence<sizeof...(T)>;
`,
};

export const TUPLE: LibrarySource = {
  names: [
    'tuple',
    'tuple_size',
    'tuple_size_v',
    'tuple_element',
    'tuple_element_t',
    'get',
    'make_tuple',
    'tie',
    'forward_as_tuple',
    'ignore',
    'apply',
    'tuple_cat',
    'make_from_tuple',
  ],
  uses: [TYPE_TRAITS, INTEGER_SEQUENCE],
  source: String.raw`
template <class... T>
class tuple;

template <>
class tuple<> {
public:
  constexpr tuple() noexcept = default;
  void swap(tuple&) noexcept {}
};

template <class H, class... R>
class tuple<H, R...> : public tuple<R...> {
public:
  H __head;

  template <class D = H>
    requires(is_default_constructible_v<D>)
  constexpr tuple() : tuple<R...>(), __head() {}
  template <class U, class... V>
    requires(sizeof...(V) == sizeof...(R) && !(sizeof...(R) == 0 && is_same_v<remove_cvref_t<U>, tuple>))
  constexpr tuple(U&& head, V&&... tail) : tuple<R...>(std::forward<V>(tail)...), __head(std::forward<U>(head)) {}
  template <class UH, class... UR>
    requires(sizeof...(UR) == sizeof...(R) && !is_same_v<tuple<UH, UR...>, tuple>)
  constexpr tuple(const tuple<UH, UR...>& other)
      : tuple<R...>(static_cast<const tuple<UR...>&>(other)), __head(other.__head) {}
  template <class UH, class... UR>
    requires(sizeof...(UR) == sizeof...(R) && !is_same_v<tuple<UH, UR...>, tuple>)
  constexpr tuple(tuple<UH, UR...>&& other)
      : tuple<R...>(static_cast<tuple<UR...>&&>(other)), __head(std::forward<UH>(other.__head)) {}
  template <class A, class B>
    requires(sizeof...(R) == 1)
  constexpr tuple(const std::pair<A, B>& p) : tuple<R...>(p.second), __head(p.first) {}
  tuple(const tuple&) = default;
  tuple(tuple&&) = default;

  constexpr tuple& operator=(const tuple& other) {
    __head = other.__head;
    __tail() = other.__tail();
    return *this;
  }
  constexpr tuple& operator=(tuple&& other) {
    __head = std::forward<H>(other.__head);
    __tail() = std::move(other.__tail());
    return *this;
  }
  template <class UH, class... UR>
    requires(sizeof...(UR) == sizeof...(R))
  constexpr tuple& operator=(const tuple<UH, UR...>& other) {
    __head = other.__head;
    __tail() = static_cast<const tuple<UR...>&>(other);
    return *this;
  }
  template <class UH, class... UR>
    requires(sizeof...(UR) == sizeof...(R))
  constexpr tuple& operator=(tuple<UH, UR...>&& other) {
    __head = std::forward<UH>(other.__head);
    __tail() = static_cast<tuple<UR...>&&>(other);
    return *this;
  }
  template <class A, class B>
    requires(sizeof...(R) == 1)
  constexpr tuple& operator=(const std::pair<A, B>& p) {
    __head = p.first;
    __tail().__head = p.second;
    return *this;
  }

  void swap(tuple& other) {
    H moved = std::move(__head);
    __head = std::move(other.__head);
    other.__head = std::move(moved);
    __tail().swap(other.__tail());
  }

  constexpr tuple<R...>& __tail() noexcept { return *this; }
  constexpr const tuple<R...>& __tail() const noexcept { return *this; }
};

template <class... T>
tuple(T...) -> tuple<T...>;
template <class A, class B>
tuple(std::pair<A, B>) -> tuple<A, B>;

template <class T>
struct tuple_size;
template <class T>
struct tuple_size<const T> : integral_constant<unsigned long, tuple_size<T>::value> {};
template <class... T>
struct tuple_size<tuple<T...>> : integral_constant<unsigned long, sizeof...(T)> {};
template <class A, class B>
struct tuple_size<std::pair<A, B>> : integral_constant<unsigned long, 2> {};
template <class T>
inline constexpr unsigned long tuple_size_v = tuple_size<T>::value;

template <unsigned long I, class T>
struct tuple_element;
template <unsigned long I, class T>
struct tuple_element<I, const T> {
  using type = add_const_t<typename tuple_element<I, T>::type>;
};
template <class H, class... R>
struct tuple_element<0, tuple<H, R...>> {
  using type = H;
};
template <unsigned long I, class H, class... R>
struct tuple_element<I, tuple<H, R...>> : tuple_element<I - 1, tuple<R...>> {};
template <class A, class B>
struct tuple_element<0, std::pair<A, B>> {
  using type = A;
};
template <class A, class B>
struct tuple_element<1, std::pair<A, B>> {
  using type = B;
};
template <unsigned long I, class T>
using tuple_element_t = typename tuple_element<I, T>::type;

template <unsigned long I>
struct __tuple_at {
  template <class H, class... R>
  static constexpr auto& get(tuple<H, R...>& t) noexcept {
    return __tuple_at<I - 1>::get(t.__tail());
  }
  template <class H, class... R>
  static constexpr const auto& get(const tuple<H, R...>& t) noexcept {
    return __tuple_at<I - 1>::get(t.__tail());
  }
};
template <>
struct __tuple_at<0> {
  template <class H, class... R>
  static constexpr auto& get(tuple<H, R...>& t) noexcept {
    return t.__head;
  }
  template <class H, class... R>
  static constexpr const auto& get(const tuple<H, R...>& t) noexcept {
    return t.__head;
  }
};

template <unsigned long I, class... T>
  requires(I < sizeof...(T))
constexpr tuple_element_t<I, tuple<T...>>& get(tuple<T...>& t) noexcept {
  return __tuple_at<I>::get(t);
}
template <unsigned long I, class... T>
  requires(I < sizeof...(T))
constexpr const tuple_element_t<I, tuple<T...>>& get(const tuple<T...>& t) noexcept {
  return __tuple_at<I>::get(t);
}
template <unsigned long I, class... T>
  requires(I < sizeof...(T))
constexpr tuple_element_t<I, tuple<T...>>&& get(tuple<T...>&& t) noexcept {
  return static_cast<tuple_element_t<I, tuple<T...>>&&>(__tuple_at<I>::get(t));
}

template <class T, class... U>
constexpr unsigned long __index_of() {
  constexpr bool same[] = {is_same_v<T, U>..., false};
  unsigned long found = sizeof...(U);
  for (unsigned long i = 0; i < sizeof...(U); ++i) {
    if (same[i]) {
      if (found != sizeof...(U)) return sizeof...(U);
      found = i;
    }
  }
  return found;
}
template <class T, class... U>
  requires(__index_of<T, U...>() < sizeof...(U))
constexpr T& get(tuple<U...>& t) noexcept {
  return __tuple_at<__index_of<T, U...>()>::get(t);
}
template <class T, class... U>
  requires(__index_of<T, U...>() < sizeof...(U))
constexpr const T& get(const tuple<U...>& t) noexcept {
  return __tuple_at<__index_of<T, U...>()>::get(t);
}

template <class... T>
constexpr tuple<decay_t<T>...> make_tuple(T&&... t) {
  return tuple<decay_t<T>...>(std::forward<T>(t)...);
}
template <class... T>
constexpr tuple<T&...> tie(T&... t) noexcept {
  return tuple<T&...>(t...);
}
template <class... T>
constexpr tuple<T&&...> forward_as_tuple(T&&... t) noexcept {
  return tuple<T&&...>(std::forward<T>(t)...);
}

struct __ignore_t {
  template <class U>
  constexpr const __ignore_t& operator=(U&&) const noexcept {
    return *this;
  }
};
inline constexpr __ignore_t ignore{};

template <class F, class Tuple, unsigned long... I>
constexpr decltype(auto) __apply(F&& f, Tuple&& t, integer_sequence<unsigned long, I...>) {
  return std::forward<F>(f)(get<I>(std::forward<Tuple>(t))...);
}
template <class F, class Tuple>
constexpr decltype(auto) apply(F&& f, Tuple&& t) {
  return __apply(std::forward<F>(f), std::forward<Tuple>(t), make_index_sequence<tuple_size_v<remove_reference_t<Tuple>>>());
}
template <class T, class Tuple, unsigned long... I>
constexpr T __make_from(Tuple&& t, integer_sequence<unsigned long, I...>) {
  return T(get<I>(std::forward<Tuple>(t))...);
}
template <class T, class Tuple>
constexpr T make_from_tuple(Tuple&& t) {
  return __make_from<T>(std::forward<Tuple>(t), make_index_sequence<tuple_size_v<remove_reference_t<Tuple>>>());
}

template <class... T, class... U, unsigned long... I, unsigned long... J>
constexpr tuple<T..., U...> __concatenate(const tuple<T...>& a, const tuple<U...>& b, integer_sequence<unsigned long, I...>,
                                          integer_sequence<unsigned long, J...>) {
  return tuple<T..., U...>(get<I>(a)..., get<J>(b)...);
}
constexpr tuple<> tuple_cat() { return tuple<>(); }
template <class... T>
constexpr tuple<T...> tuple_cat(const tuple<T...>& t) {
  return t;
}
template <class... T, class... U, class... Rest>
constexpr auto tuple_cat(const tuple<T...>& a, const tuple<U...>& b, const Rest&... rest) {
  return tuple_cat(__concatenate(a, b, index_sequence_for<T...>(), index_sequence_for<U...>()), rest...);
}

template <unsigned long I, unsigned long N>
struct __tuple_compare {
  template <class A, class B>
  static constexpr bool equal(const A& a, const B& b) {
    return get<I>(a) == get<I>(b) && __tuple_compare<I + 1, N>::equal(a, b);
  }
  template <class A, class B>
  static constexpr bool less(const A& a, const B& b) {
    if (get<I>(a) < get<I>(b)) return true;
    if (get<I>(b) < get<I>(a)) return false;
    return __tuple_compare<I + 1, N>::less(a, b);
  }
};
template <unsigned long N>
struct __tuple_compare<N, N> {
  template <class A, class B>
  static constexpr bool equal(const A&, const B&) {
    return true;
  }
  template <class A, class B>
  static constexpr bool less(const A&, const B&) {
    return false;
  }
};

template <class... T, class... U>
  requires(sizeof...(T) == sizeof...(U))
constexpr bool operator==(const tuple<T...>& a, const tuple<U...>& b) {
  return __tuple_compare<0, sizeof...(T)>::equal(a, b);
}
template <class... T, class... U>
  requires(sizeof...(T) == sizeof...(U))
constexpr bool operator!=(const tuple<T...>& a, const tuple<U...>& b) {
  return !(a == b);
}
template <class... T, class... U>
  requires(sizeof...(T) == sizeof...(U))
constexpr bool operator<(const tuple<T...>& a, const tuple<U...>& b) {
  return __tuple_compare<0, sizeof...(T)>::less(a, b);
}
template <class... T, class... U>
  requires(sizeof...(T) == sizeof...(U))
constexpr bool operator>(const tuple<T...>& a, const tuple<U...>& b) {
  return b < a;
}
template <class... T, class... U>
  requires(sizeof...(T) == sizeof...(U))
constexpr bool operator<=(const tuple<T...>& a, const tuple<U...>& b) {
  return !(b < a);
}
template <class... T, class... U>
  requires(sizeof...(T) == sizeof...(U))
constexpr bool operator>=(const tuple<T...>& a, const tuple<U...>& b) {
  return !(a < b);
}
template <class... T>
void swap(tuple<T...>& a, tuple<T...>& b) {
  a.swap(b);
}
`,
};
