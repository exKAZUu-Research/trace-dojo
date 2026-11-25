import type { LibrarySource } from '../librarySources';
import { TYPE_TRAITS } from './typeTraits';

export const VARIANT: LibrarySource = {
  names: [
    'variant',
    'monostate',
    'visit',
    'holds_alternative',
    'get_if',
    'variant_size',
    'variant_size_v',
    'variant_alternative',
    'variant_alternative_t',
    'variant_npos',
    'in_place_index',
    'in_place_index_t',
    'in_place_type',
    'in_place_type_t',
  ],
  uses: [TYPE_TRAITS],
  source: String.raw`
struct monostate {};
constexpr bool operator==(monostate, monostate) noexcept { return true; }
constexpr bool operator!=(monostate, monostate) noexcept { return false; }
constexpr bool operator<(monostate, monostate) noexcept { return false; }

inline constexpr unsigned long variant_npos = -1;

template <unsigned long I> struct in_place_index_t { explicit in_place_index_t() = default; };
template <unsigned long I> inline constexpr in_place_index_t<I> in_place_index{};
template <class T> struct in_place_type_t { explicit in_place_type_t() = default; };
template <class T> inline constexpr in_place_type_t<T> in_place_type{};

template <class... T>
union __variant_storage {
  char __none;
  constexpr __variant_storage() : __none() {}
};
template <class H, class... R>
union __variant_storage<H, R...> {
  char __none;
  H __head;
  __variant_storage<R...> __tail;
  constexpr __variant_storage() : __none() {}
  ~__variant_storage() {}
};

template <unsigned long I>
struct __variant_at {
  template <class S>
  static constexpr auto& get(S& s) noexcept {
    return __variant_at<I - 1>::get(s.__tail);
  }
  // The storage of alternative I, making the nested unions on the way to it.
  template <class S>
  static constexpr auto& make(S& s) {
    using Tail = decltype(s.__tail);
    new (&s.__tail) Tail();
    return __variant_at<I - 1>::make(s.__tail);
  }
};
template <>
struct __variant_at<0> {
  template <class S>
  static constexpr auto& get(S& s) noexcept {
    return s.__head;
  }
  template <class S>
  static constexpr auto& make(S& s) {
    return s.__head;
  }
};

template <unsigned long I, class... T>
struct __type_at;
template <class H, class... R>
struct __type_at<0, H, R...> {
  using type = H;
};
template <unsigned long I, class H, class... R>
struct __type_at<I, H, R...> : __type_at<I - 1, R...> {};

template <class T, class... U>
constexpr unsigned long __find_alternative() {
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

template <class... T>
class variant {
  __variant_storage<T...> __storage;
  unsigned char __index = 0;

  template <unsigned long I>
  void __destroy() noexcept {
    if constexpr (I < sizeof...(T)) {
      if (__index == I) {
        using A = typename __type_at<I, T...>::type;
        __variant_at<I>::get(__storage).~A();
      } else {
        __destroy<I + 1>();
      }
    }
  }
  template <unsigned long I, class... Args>
  void __construct(Args&&... args) {
    using A = typename __type_at<I, T...>::type;
    new (&__variant_at<I>::make(__storage)) A(std::forward<Args>(args)...);
    __index = I;
  }
  template <unsigned long I, class V>
  void __copy_from(V&& other) {
    if constexpr (I < sizeof...(T)) {
      if (other.__index == I) __construct<I>(std::forward<V>(other).template __get<I>());
      else __copy_from<I + 1>(std::forward<V>(other));
    }
  }
  template <unsigned long I, class V>
  void __assign_from(V&& other) {
    if constexpr (I < sizeof...(T)) {
      if (other.__index == I) {
        if (__index == I) __get<I>() = std::forward<V>(other).template __get<I>();
        else emplace<I>(std::forward<V>(other).template __get<I>());
      } else {
        __assign_from<I + 1>(std::forward<V>(other));
      }
    }
  }

public:
  template <class D = typename __type_at<0, T...>::type>
    requires(is_default_constructible_v<D>)
  constexpr variant() {
    __construct<0>();
  }
  variant(const variant& other) { __copy_from<0>(other); }
  variant(variant&& other) { __copy_from<0>(std::move(other)); }
  template <class U, unsigned long I = __best_alternative(U, T...)>
    requires(!is_same_v<remove_cvref_t<U>, variant> && I < sizeof...(T))
  constexpr variant(U&& value) {
    __construct<I>(std::forward<U>(value));
  }
  template <class A, class... Args, unsigned long I = __find_alternative<A, T...>()>
    requires(I < sizeof...(T))
  constexpr explicit variant(in_place_type_t<A>, Args&&... args) {
    __construct<I>(std::forward<Args>(args)...);
  }
  template <unsigned long I, class... Args>
    requires(I < sizeof...(T))
  constexpr explicit variant(in_place_index_t<I>, Args&&... args) {
    __construct<I>(std::forward<Args>(args)...);
  }
  ~variant() { __destroy<0>(); }

  variant& operator=(const variant& other) {
    if (this != &other) __assign_from<0>(other);
    return *this;
  }
  variant& operator=(variant&& other) {
    if (this != &other) __assign_from<0>(std::move(other));
    return *this;
  }
  template <class U, unsigned long I = __best_alternative(U, T...)>
    requires(!is_same_v<remove_cvref_t<U>, variant> && I < sizeof...(T))
  variant& operator=(U&& value) {
    if (__index == I) __get<I>() = std::forward<U>(value);
    else emplace<I>(std::forward<U>(value));
    return *this;
  }

  template <unsigned long I, class... Args>
    requires(I < sizeof...(T))
  auto& emplace(Args&&... args) {
    __destroy<0>();
    __construct<I>(std::forward<Args>(args)...);
    return __get<I>();
  }
  template <class A, class... Args, unsigned long I = __find_alternative<A, T...>()>
    requires(I < sizeof...(T))
  A& emplace(Args&&... args) {
    return emplace<I>(std::forward<Args>(args)...);
  }

  constexpr unsigned long index() const noexcept { return __index; }
  constexpr bool valueless_by_exception() const noexcept { return false; }
  void swap(variant& other) {
    variant moved(std::move(other));
    other = std::move(*this);
    *this = std::move(moved);
  }

  template <unsigned long I>
  constexpr auto& __get() & noexcept {
    return __variant_at<I>::get(__storage);
  }
  template <unsigned long I>
  constexpr const auto& __get() const& noexcept {
    return __variant_at<I>::get(__storage);
  }
  template <unsigned long I>
  constexpr auto&& __get() && noexcept {
    return std::move(__variant_at<I>::get(__storage));
  }
};

template <class V>
struct variant_size;
template <class... T>
struct variant_size<variant<T...>> : integral_constant<unsigned long, sizeof...(T)> {};
template <class V>
struct variant_size<const V> : variant_size<V> {};
template <class V>
inline constexpr unsigned long variant_size_v = variant_size<V>::value;
template <unsigned long I, class V>
struct variant_alternative;
template <unsigned long I, class... T>
struct variant_alternative<I, variant<T...>> {
  using type = typename __type_at<I, T...>::type;
};
template <unsigned long I, class V>
using variant_alternative_t = typename variant_alternative<I, V>::type;

template <class A, class... T>
constexpr bool holds_alternative(const variant<T...>& v) noexcept {
  return v.index() == __find_alternative<A, T...>();
}

template <unsigned long I, class... T>
  requires(I < sizeof...(T))
constexpr typename __type_at<I, T...>::type& get(variant<T...>& v) {
  if (v.index() != I) throw std::bad_variant_access();
  return v.template __get<I>();
}
template <unsigned long I, class... T>
  requires(I < sizeof...(T))
constexpr const typename __type_at<I, T...>::type& get(const variant<T...>& v) {
  if (v.index() != I) throw std::bad_variant_access();
  return v.template __get<I>();
}
template <unsigned long I, class... T>
  requires(I < sizeof...(T))
constexpr typename __type_at<I, T...>::type&& get(variant<T...>&& v) {
  if (v.index() != I) throw std::bad_variant_access();
  return std::move(v.template __get<I>());
}
template <class A, class... T>
  requires(__find_alternative<A, T...>() < sizeof...(T))
constexpr A& get(variant<T...>& v) {
  return get<__find_alternative<A, T...>()>(v);
}
template <class A, class... T>
  requires(__find_alternative<A, T...>() < sizeof...(T))
constexpr const A& get(const variant<T...>& v) {
  return get<__find_alternative<A, T...>()>(v);
}
template <unsigned long I, class... T>
constexpr add_pointer_t<typename __type_at<I, T...>::type> get_if(variant<T...>* v) noexcept {
  return v && v->index() == I ? &v->template __get<I>() : nullptr;
}
template <unsigned long I, class... T>
constexpr add_pointer_t<const typename __type_at<I, T...>::type> get_if(const variant<T...>* v) noexcept {
  return v && v->index() == I ? &v->template __get<I>() : nullptr;
}
template <class A, class... T>
constexpr add_pointer_t<A> get_if(variant<T...>* v) noexcept {
  return get_if<__find_alternative<A, T...>()>(v);
}
template <class A, class... T>
constexpr add_pointer_t<const A> get_if(const variant<T...>* v) noexcept {
  return get_if<__find_alternative<A, T...>()>(v);
}

template <unsigned long I, class F, class V>
constexpr decltype(auto) __visit_at(F&& f, V&& v) {
  if constexpr (I + 1 < variant_size_v<remove_cvref_t<V>>) {
    if (v.index() != I) return __visit_at<I + 1>(std::forward<F>(f), std::forward<V>(v));
  }
  return std::forward<F>(f)(std::forward<V>(v).template __get<I>());
}
template <class F, class V>
constexpr decltype(auto) visit(F&& f, V&& v) {
  return __visit_at<0>(std::forward<F>(f), std::forward<V>(v));
}
template <class R, class F, class V>
constexpr R visit(F&& f, V&& v) {
  return static_cast<R>(__visit_at<0>(std::forward<F>(f), std::forward<V>(v)));
}

template <unsigned long I, class... T>
constexpr bool __equal_at(const variant<T...>& a, const variant<T...>& b) {
  if constexpr (I < sizeof...(T)) {
    if (a.index() == I) return a.template __get<I>() == b.template __get<I>();
    return __equal_at<I + 1>(a, b);
  }
  return true;
}
template <unsigned long I, class... T>
constexpr bool __less_at(const variant<T...>& a, const variant<T...>& b) {
  if constexpr (I < sizeof...(T)) {
    if (a.index() == I) return a.template __get<I>() < b.template __get<I>();
    return __less_at<I + 1>(a, b);
  }
  return false;
}
template <class... T>
constexpr bool operator==(const variant<T...>& a, const variant<T...>& b) {
  return a.index() == b.index() && __equal_at<0>(a, b);
}
template <class... T>
constexpr bool operator!=(const variant<T...>& a, const variant<T...>& b) {
  return !(a == b);
}
template <class... T>
constexpr bool operator<(const variant<T...>& a, const variant<T...>& b) {
  if (a.index() != b.index()) return a.index() < b.index();
  return __less_at<0>(a, b);
}
template <class... T>
constexpr bool operator>(const variant<T...>& a, const variant<T...>& b) {
  return b < a;
}
template <class... T>
void swap(variant<T...>& a, variant<T...>& b) {
  a.swap(b);
}
`,
};
