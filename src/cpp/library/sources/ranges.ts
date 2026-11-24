import type { LibrarySource } from '../librarySources';
import { INVOKE } from './invoke';
import { TUPLE } from './tuple';
import { TYPE_TRAITS } from './typeTraits';
import { UTILITY } from './utility';

/**
 * `<ranges>` and the range algorithms of `<algorithm>`: the views, which iterate over the ranges they adapt lazily, the
 * adaptors of `std::views` that `|` applies, and the algorithms of `std::ranges` with comparators and projections.
 */
export const RANGES: LibrarySource = {
  names: ['ranges', 'views'],
  uses: [TYPE_TRAITS, INVOKE, TUPLE, UTILITY],
  source: String.raw`
namespace ranges {

template <class R>
constexpr auto begin(R& r) {
  if constexpr (is_array_v<R>) return r + 0;
  else return r.begin();
}
template <class R>
constexpr auto end(R& r) {
  if constexpr (is_array_v<R>) return r + extent_v<R>;
  else return r.end();
}
template <class R>
constexpr auto size(R& r) {
  if constexpr (is_array_v<R>) return extent_v<R>;
  else if constexpr (requires { r.size(); }) return r.size();
  else {
    unsigned long count = 0;
    for (auto it = ranges::begin(r); it != ranges::end(r); ++it) ++count;
    return count;
  }
}
template <class R>
constexpr bool empty(R& r) {
  return !(ranges::begin(r) != ranges::end(r));
}
template <class R>
constexpr long distance(R& r) {
  long count = 0;
  for (auto it = ranges::begin(r); it != ranges::end(r); ++it) ++count;
  return count;
}

template <class R>
using iterator_t = decltype(ranges::begin(declval<R&>()));
template <class R>
using sentinel_t = decltype(ranges::end(declval<R&>()));
template <class R>
using range_reference_t = decltype(*declval<iterator_t<R>&>());
template <class R>
using range_value_t = remove_cvref_t<range_reference_t<R>>;

struct less {
  template <class T, class U>
  constexpr bool operator()(T&& t, U&& u) const {
    return std::forward<T>(t) < std::forward<U>(u);
  }
  using is_transparent = void;
};
struct greater {
  template <class T, class U>
  constexpr bool operator()(T&& t, U&& u) const {
    return std::forward<U>(u) < std::forward<T>(t);
  }
  using is_transparent = void;
};
struct equal_to {
  template <class T, class U>
  constexpr bool operator()(T&& t, U&& u) const {
    return std::forward<T>(t) == std::forward<U>(u);
  }
  using is_transparent = void;
};

struct view_base {};
template <class D>
struct view_interface : view_base {
  constexpr bool empty() { return !(static_cast<D&>(*this).begin() != static_cast<D&>(*this).end()); }
  constexpr explicit operator bool() { return !empty(); }
  constexpr decltype(auto) front() { return *static_cast<D&>(*this).begin(); }
};

template <class T>
inline constexpr bool __is_view = is_base_of_v<view_base, remove_cvref_t<T>>;

template <class R>
class ref_view : public view_interface<ref_view<R>> {
  R* __range;

public:
  constexpr ref_view(R& range) : __range(std::addressof(range)) {}
  constexpr auto begin() const { return ranges::begin(*__range); }
  constexpr auto end() const { return ranges::end(*__range); }
  constexpr auto size() const { return ranges::size(*__range); }
  constexpr R& base() const { return *__range; }
};
template <class R>
class owning_view : public view_interface<owning_view<R>> {
  R __range;

public:
  constexpr owning_view(R&& range) : __range(std::move(range)) {}
  constexpr auto begin() { return ranges::begin(__range); }
  constexpr auto end() { return ranges::end(__range); }
  constexpr auto begin() const { return ranges::begin(__range); }
  constexpr auto end() const { return ranges::end(__range); }
  constexpr auto size() const { return ranges::size(__range); }
};

template <class R>
constexpr auto __all(R&& range) {
  if constexpr (__is_view<R>) return remove_cvref_t<R>(std::forward<R>(range));
  else if constexpr (is_lvalue_reference_v<R>) return ref_view<remove_reference_t<R>>(range);
  else return owning_view<remove_cvref_t<R>>(std::move(range));
}
template <class R>
using __all_t = decltype(__all(declval<R>()));

template <class V, class P>
class filter_view : public view_interface<filter_view<V, P>> {
  V __base;
  P __pred;

public:
  struct sentinel {
    sentinel_t<V> __end;
  };
  class iterator {
    filter_view* __parent = nullptr;
    iterator_t<V> __current{};

    constexpr void __satisfy() {
      while (__current != __parent->__base.end() && !std::invoke(__parent->__pred, *__current)) ++__current;
    }

  public:
    using difference_type = long;
    using value_type = range_value_t<V>;
    constexpr iterator() = default;
    constexpr iterator(filter_view& parent, iterator_t<V> current) : __parent(&parent), __current(current) {
      __satisfy();
    }
    constexpr decltype(auto) operator*() const { return *__current; }
    constexpr iterator& operator++() {
      ++__current;
      __satisfy();
      return *this;
    }
    constexpr iterator operator++(int) {
      iterator old = *this;
      ++*this;
      return old;
    }
    constexpr iterator& operator--() {
      do --__current;
      while (!std::invoke(__parent->__pred, *__current));
      return *this;
    }
    constexpr iterator_t<V> base() const { return __current; }
    friend constexpr bool operator==(const iterator& a, const iterator& b) { return a.__current == b.__current; }
    friend constexpr bool operator!=(const iterator& a, const iterator& b) { return !(a.__current == b.__current); }
    friend constexpr bool operator==(const iterator& a, const sentinel& s) { return a.__current == s.__end; }
    friend constexpr bool operator!=(const iterator& a, const sentinel& s) { return !(a.__current == s.__end); }
  };

  constexpr filter_view(V base, P pred) : __base(std::move(base)), __pred(std::move(pred)) {}
  constexpr iterator begin() { return iterator(*this, __base.begin()); }
  constexpr sentinel end() { return sentinel{__base.end()}; }
  constexpr V base() const { return __base; }
};

template <class V, class F>
class transform_view : public view_interface<transform_view<V, F>> {
  V __base;
  F __f;

public:
  struct sentinel {
    sentinel_t<V> __end;
  };
  class iterator {
    transform_view* __parent = nullptr;
    iterator_t<V> __current{};

  public:
    using difference_type = long;
    constexpr iterator() = default;
    constexpr iterator(transform_view& parent, iterator_t<V> current) : __parent(&parent), __current(current) {}
    constexpr decltype(auto) operator*() const { return std::invoke(__parent->__f, *__current); }
    constexpr iterator& operator++() {
      ++__current;
      return *this;
    }
    constexpr iterator operator++(int) {
      iterator old = *this;
      ++__current;
      return old;
    }
    constexpr iterator& operator--() {
      --__current;
      return *this;
    }
    constexpr iterator operator+(long n) const { return iterator(*__parent, __current + n); }
    constexpr iterator operator-(long n) const { return iterator(*__parent, __current - n); }
    constexpr long operator-(const iterator& other) const { return __current - other.__current; }
    constexpr decltype(auto) operator[](long n) const { return std::invoke(__parent->__f, __current[n]); }
    constexpr iterator_t<V> base() const { return __current; }
    friend constexpr bool operator==(const iterator& a, const iterator& b) { return a.__current == b.__current; }
    friend constexpr bool operator!=(const iterator& a, const iterator& b) { return !(a.__current == b.__current); }
    friend constexpr bool operator==(const iterator& a, const sentinel& s) { return a.__current == s.__end; }
    friend constexpr bool operator!=(const iterator& a, const sentinel& s) { return !(a.__current == s.__end); }
  };

  constexpr transform_view(V base, F f) : __base(std::move(base)), __f(std::move(f)) {}
  constexpr iterator begin() { return iterator(*this, __base.begin()); }
  constexpr sentinel end() { return sentinel{__base.end()}; }
  constexpr auto size() { return ranges::size(__base); }
};

template <class V>
class take_view : public view_interface<take_view<V>> {
  V __base;
  long __count;

public:
  class iterator {
    iterator_t<V> __current{};
    sentinel_t<V> __end{};
    long __remaining = 0;

  public:
    using difference_type = long;
    constexpr iterator() = default;
    constexpr iterator(iterator_t<V> current, sentinel_t<V> end, long remaining)
        : __current(current), __end(end), __remaining(remaining) {}
    constexpr decltype(auto) operator*() const { return *__current; }
    constexpr iterator& operator++() {
      ++__current;
      --__remaining;
      return *this;
    }
    constexpr iterator operator++(int) {
      iterator old = *this;
      ++*this;
      return old;
    }
    constexpr bool __done() const { return __remaining <= 0 || !(__current != __end); }
    friend constexpr bool operator==(const iterator& a, const iterator& b) {
      if (a.__done() || b.__done()) return a.__done() && b.__done();
      return a.__current == b.__current;
    }
    friend constexpr bool operator!=(const iterator& a, const iterator& b) { return !(a == b); }
  };

  constexpr take_view(V base, long count) : __base(std::move(base)), __count(count) {}
  constexpr iterator begin() { return iterator(__base.begin(), __base.end(), __count); }
  constexpr iterator end() { return iterator(__base.begin(), __base.end(), 0); }
  constexpr auto size() {
    long whole = static_cast<long>(ranges::size(__base));
    return static_cast<unsigned long>(whole < __count ? whole : __count);
  }
};

template <class V>
class drop_view : public view_interface<drop_view<V>> {
  V __base;
  long __count;

public:
  constexpr drop_view(V base, long count) : __base(std::move(base)), __count(count) {}
  constexpr auto begin() {
    auto it = __base.begin();
    for (long n = 0; n < __count && it != __base.end(); ++n) ++it;
    return it;
  }
  constexpr auto end() { return __base.end(); }
  constexpr auto size() {
    long whole = static_cast<long>(ranges::size(__base));
    return static_cast<unsigned long>(whole < __count ? 0 : whole - __count);
  }
};

template <class V, class P>
class take_while_view : public view_interface<take_while_view<V, P>> {
  V __base;
  P __pred;

public:
  class iterator {
    take_while_view* __parent = nullptr;
    iterator_t<V> __current{};
    sentinel_t<V> __end{};
    bool __isEnd = false;

  public:
    using difference_type = long;
    constexpr iterator() = default;
    constexpr iterator(take_while_view& parent, iterator_t<V> current, sentinel_t<V> end, bool isEnd)
        : __parent(&parent), __current(current), __end(end), __isEnd(isEnd) {}
    constexpr decltype(auto) operator*() const { return *__current; }
    constexpr iterator& operator++() {
      ++__current;
      return *this;
    }
    constexpr iterator operator++(int) {
      iterator old = *this;
      ++__current;
      return old;
    }
    constexpr bool __done() const {
      return __isEnd || !(__current != __end) || !std::invoke(__parent->__pred, *__current);
    }
    friend constexpr bool operator==(const iterator& a, const iterator& b) {
      if (a.__done() || b.__done()) return a.__done() && b.__done();
      return a.__current == b.__current;
    }
    friend constexpr bool operator!=(const iterator& a, const iterator& b) { return !(a == b); }
  };

  constexpr take_while_view(V base, P pred) : __base(std::move(base)), __pred(std::move(pred)) {}
  constexpr iterator begin() { return iterator(*this, __base.begin(), __base.end(), false); }
  constexpr iterator end() { return iterator(*this, __base.begin(), __base.end(), true); }
};

template <class V, class P>
class drop_while_view : public view_interface<drop_while_view<V, P>> {
  V __base;
  P __pred;

public:
  constexpr drop_while_view(V base, P pred) : __base(std::move(base)), __pred(std::move(pred)) {}
  constexpr auto begin() {
    auto it = __base.begin();
    while (it != __base.end() && std::invoke(__pred, *it)) ++it;
    return it;
  }
  constexpr auto end() { return __base.end(); }
};

template <class V>
class reverse_view : public view_interface<reverse_view<V>> {
  V __base;

public:
  constexpr reverse_view(V base) : __base(std::move(base)) {}
  constexpr auto begin() { return std::make_reverse_iterator(__base.end()); }
  constexpr auto end() { return std::make_reverse_iterator(__base.begin()); }
  constexpr auto size() { return ranges::size(__base); }
};

template <class V, unsigned long N>
class elements_view : public view_interface<elements_view<V, N>> {
  V __base;

public:
  class iterator {
    iterator_t<V> __current{};

  public:
    using difference_type = long;
    constexpr iterator() = default;
    constexpr explicit iterator(iterator_t<V> current) : __current(current) {}
    constexpr decltype(auto) operator*() const { return std::get<N>(*__current); }
    constexpr iterator& operator++() {
      ++__current;
      return *this;
    }
    constexpr iterator operator++(int) {
      iterator old = *this;
      ++__current;
      return old;
    }
    constexpr iterator& operator--() {
      --__current;
      return *this;
    }
    friend constexpr bool operator==(const iterator& a, const iterator& b) { return a.__current == b.__current; }
    friend constexpr bool operator!=(const iterator& a, const iterator& b) { return !(a.__current == b.__current); }
  };

  constexpr elements_view(V base) : __base(std::move(base)) {}
  constexpr iterator begin() { return iterator(__base.begin()); }
  constexpr iterator end() { return iterator(__base.end()); }
  constexpr auto size() { return ranges::size(__base); }
};

template <class W, class Bound = W>
class iota_view : public view_interface<iota_view<W, Bound>> {
  W __value;
  Bound __bound;
  bool __unbounded;

public:
  class iterator {
    W __value{};

  public:
    using difference_type = long;
    using value_type = W;
    constexpr iterator() = default;
    constexpr explicit iterator(W value) : __value(value) {}
    constexpr W operator*() const { return __value; }
    constexpr iterator& operator++() {
      ++__value;
      return *this;
    }
    constexpr iterator operator++(int) {
      iterator old = *this;
      ++__value;
      return old;
    }
    constexpr iterator& operator--() {
      --__value;
      return *this;
    }
    constexpr iterator operator+(long n) const { return iterator(static_cast<W>(__value + n)); }
    constexpr iterator operator-(long n) const { return iterator(static_cast<W>(__value - n)); }
    constexpr long operator-(const iterator& other) const { return static_cast<long>(__value - other.__value); }
    constexpr W operator[](long n) const { return static_cast<W>(__value + n); }
    friend constexpr bool operator==(const iterator& a, const iterator& b) { return a.__value == b.__value; }
    friend constexpr bool operator!=(const iterator& a, const iterator& b) { return !(a.__value == b.__value); }
  };
  class sentinel {
    Bound __bound{};
    bool __unbounded = true;

  public:
    constexpr sentinel() = default;
    constexpr sentinel(Bound bound, bool unbounded) : __bound(bound), __unbounded(unbounded) {}
    friend constexpr bool operator==(const iterator& it, const sentinel& s) { return !s.__unbounded && *it == s.__bound; }
    friend constexpr bool operator!=(const iterator& it, const sentinel& s) { return !(it == s); }
  };

  constexpr explicit iota_view(W value) : __value(value), __bound(), __unbounded(true) {}
  constexpr iota_view(W value, Bound bound) : __value(value), __bound(bound), __unbounded(false) {}
  constexpr iterator begin() const { return iterator(__value); }
  constexpr sentinel end() const { return sentinel(__bound, __unbounded); }
  constexpr unsigned long size() const { return static_cast<unsigned long>(__bound - __value); }
};

template <class T>
class single_view : public view_interface<single_view<T>> {
  T __value;

public:
  constexpr explicit single_view(T value) : __value(std::move(value)) {}
  constexpr T* begin() { return std::addressof(__value); }
  constexpr T* end() { return std::addressof(__value) + 1; }
  constexpr unsigned long size() const { return 1; }
};

template <class T>
class empty_view : public view_interface<empty_view<T>> {
public:
  constexpr T* begin() const { return nullptr; }
  constexpr T* end() const { return nullptr; }
  constexpr unsigned long size() const { return 0; }
};

template <class F>
struct __closure {
  F __apply;
  template <class R>
  constexpr auto operator()(R&& range) const {
    return __apply(std::forward<R>(range));
  }
};
template <class F>
__closure(F) -> __closure<F>;

template <class T>
struct __is_closure : false_type {};
template <class F>
struct __is_closure<__closure<F>> : true_type {};

template <class R, class F>
  requires(!__is_closure<remove_cvref_t<R>>::value)
constexpr auto operator|(R&& range, const __closure<F>& closure) {
  return closure(std::forward<R>(range));
}
template <class F, class G>
constexpr auto operator|(const __closure<F>& first, const __closure<G>& second) {
  return __closure{[first, second](auto&& range) { return second(first(std::forward<decltype(range)>(range))); }};
}

namespace views {
struct __all_fn {
  template <class R>
  constexpr auto operator()(R&& range) const {
    return __all(std::forward<R>(range));
  }
};
inline constexpr __closure<__all_fn> all{__all_fn{}};

struct __filter_fn {
  template <class R, class P>
  constexpr auto operator()(R&& range, P pred) const {
    return filter_view<__all_t<R>, P>(__all(std::forward<R>(range)), std::move(pred));
  }
  template <class P>
  constexpr auto operator()(P pred) const {
    return __closure{[pred](auto&& range) { return __filter_fn{}(std::forward<decltype(range)>(range), pred); }};
  }
};
inline constexpr __filter_fn filter{};

struct __transform_fn {
  template <class R, class F>
  constexpr auto operator()(R&& range, F f) const {
    return transform_view<__all_t<R>, F>(__all(std::forward<R>(range)), std::move(f));
  }
  template <class F>
  constexpr auto operator()(F f) const {
    return __closure{[f](auto&& range) { return __transform_fn{}(std::forward<decltype(range)>(range), f); }};
  }
};
inline constexpr __transform_fn transform{};

struct __take_fn {
  template <class R>
  constexpr auto operator()(R&& range, long count) const {
    return take_view<__all_t<R>>(__all(std::forward<R>(range)), count);
  }
  constexpr auto operator()(long count) const {
    return __closure{[count](auto&& range) { return __take_fn{}(std::forward<decltype(range)>(range), count); }};
  }
};
inline constexpr __take_fn take{};

struct __drop_fn {
  template <class R>
  constexpr auto operator()(R&& range, long count) const {
    return drop_view<__all_t<R>>(__all(std::forward<R>(range)), count);
  }
  constexpr auto operator()(long count) const {
    return __closure{[count](auto&& range) { return __drop_fn{}(std::forward<decltype(range)>(range), count); }};
  }
};
inline constexpr __drop_fn drop{};

struct __take_while_fn {
  template <class R, class P>
  constexpr auto operator()(R&& range, P pred) const {
    return take_while_view<__all_t<R>, P>(__all(std::forward<R>(range)), std::move(pred));
  }
  template <class P>
  constexpr auto operator()(P pred) const {
    return __closure{[pred](auto&& range) { return __take_while_fn{}(std::forward<decltype(range)>(range), pred); }};
  }
};
inline constexpr __take_while_fn take_while{};

struct __drop_while_fn {
  template <class R, class P>
  constexpr auto operator()(R&& range, P pred) const {
    return drop_while_view<__all_t<R>, P>(__all(std::forward<R>(range)), std::move(pred));
  }
  template <class P>
  constexpr auto operator()(P pred) const {
    return __closure{[pred](auto&& range) { return __drop_while_fn{}(std::forward<decltype(range)>(range), pred); }};
  }
};
inline constexpr __drop_while_fn drop_while{};

struct __reverse_fn {
  template <class R>
  constexpr auto operator()(R&& range) const {
    return reverse_view<__all_t<R>>(__all(std::forward<R>(range)));
  }
};
inline constexpr __closure<__reverse_fn> reverse{__reverse_fn{}};

template <unsigned long N>
struct __elements_fn {
  template <class R>
  constexpr auto operator()(R&& range) const {
    return elements_view<__all_t<R>, N>(__all(std::forward<R>(range)));
  }
};
template <unsigned long N>
inline constexpr __closure<__elements_fn<N>> elements{__elements_fn<N>{}};
inline constexpr __closure<__elements_fn<0>> keys{__elements_fn<0>{}};
inline constexpr __closure<__elements_fn<1>> values{__elements_fn<1>{}};

struct __iota_fn {
  template <class W>
  constexpr auto operator()(W value) const {
    return iota_view<W>(value);
  }
  template <class W, class Bound>
  constexpr auto operator()(W value, Bound bound) const {
    return iota_view<W, Bound>(value, bound);
  }
};
inline constexpr __iota_fn iota{};

struct __single_fn {
  template <class T>
  constexpr auto operator()(T value) const {
    return single_view<T>(std::move(value));
  }
};
inline constexpr __single_fn single{};
template <class T>
inline constexpr empty_view<T> empty{};
}  // namespace views

// Algorithms -------------------------------------------------------------------------------------------------------

template <class I, class O>
struct in_out_result {
  I in;
  O out;
};
template <class I, class F>
struct in_fun_result {
  I in;
  F fun;
};
template <class T>
struct min_max_result {
  T min;
  T max;
};

struct __for_each_fn {
  template <class R, class F, class P = identity>
  constexpr auto operator()(R&& range, F f, P proj = {}) const {
    auto it = ranges::begin(range);
    for (; it != ranges::end(range); ++it) std::invoke(f, std::invoke(proj, *it));
    return in_fun_result<decltype(it), F>{it, std::move(f)};
  }
};
inline constexpr __for_each_fn for_each{};

struct __find_fn {
  template <class R, class T, class P = identity>
  constexpr auto operator()(R&& range, const T& value, P proj = {}) const {
    auto it = ranges::begin(range);
    while (it != ranges::end(range) && !(std::invoke(proj, *it) == value)) ++it;
    return it;
  }
};
inline constexpr __find_fn find{};

struct __find_if_fn {
  template <class R, class F, class P = identity>
  constexpr auto operator()(R&& range, F pred, P proj = {}) const {
    auto it = ranges::begin(range);
    while (it != ranges::end(range) && !std::invoke(pred, std::invoke(proj, *it))) ++it;
    return it;
  }
};
inline constexpr __find_if_fn find_if{};

struct __find_if_not_fn {
  template <class R, class F, class P = identity>
  constexpr auto operator()(R&& range, F pred, P proj = {}) const {
    auto it = ranges::begin(range);
    while (it != ranges::end(range) && std::invoke(pred, std::invoke(proj, *it))) ++it;
    return it;
  }
};
inline constexpr __find_if_not_fn find_if_not{};

struct __count_fn {
  template <class R, class T, class P = identity>
  constexpr long operator()(R&& range, const T& value, P proj = {}) const {
    long n = 0;
    for (auto it = ranges::begin(range); it != ranges::end(range); ++it)
      if (std::invoke(proj, *it) == value) ++n;
    return n;
  }
};
inline constexpr __count_fn count{};

struct __count_if_fn {
  template <class R, class F, class P = identity>
  constexpr long operator()(R&& range, F pred, P proj = {}) const {
    long n = 0;
    for (auto it = ranges::begin(range); it != ranges::end(range); ++it)
      if (std::invoke(pred, std::invoke(proj, *it))) ++n;
    return n;
  }
};
inline constexpr __count_if_fn count_if{};

struct __all_of_fn {
  template <class R, class F, class P = identity>
  constexpr bool operator()(R&& range, F pred, P proj = {}) const {
    for (auto it = ranges::begin(range); it != ranges::end(range); ++it)
      if (!std::invoke(pred, std::invoke(proj, *it))) return false;
    return true;
  }
};
inline constexpr __all_of_fn all_of{};

struct __any_of_fn {
  template <class R, class F, class P = identity>
  constexpr bool operator()(R&& range, F pred, P proj = {}) const {
    for (auto it = ranges::begin(range); it != ranges::end(range); ++it)
      if (std::invoke(pred, std::invoke(proj, *it))) return true;
    return false;
  }
};
inline constexpr __any_of_fn any_of{};

struct __none_of_fn {
  template <class R, class F, class P = identity>
  constexpr bool operator()(R&& range, F pred, P proj = {}) const {
    return !__any_of_fn{}(range, pred, proj);
  }
};
inline constexpr __none_of_fn none_of{};

struct __min_element_fn {
  template <class R, class C = less, class P = identity>
  constexpr auto operator()(R&& range, C comp = {}, P proj = {}) const {
    auto best = ranges::begin(range);
    if (best == ranges::end(range)) return best;
    auto it = best;
    for (++it; it != ranges::end(range); ++it)
      if (std::invoke(comp, std::invoke(proj, *it), std::invoke(proj, *best))) best = it;
    return best;
  }
};
inline constexpr __min_element_fn min_element{};

struct __max_element_fn {
  template <class R, class C = less, class P = identity>
  constexpr auto operator()(R&& range, C comp = {}, P proj = {}) const {
    auto best = ranges::begin(range);
    if (best == ranges::end(range)) return best;
    auto it = best;
    for (++it; it != ranges::end(range); ++it)
      if (std::invoke(comp, std::invoke(proj, *best), std::invoke(proj, *it))) best = it;
    return best;
  }
};
inline constexpr __max_element_fn max_element{};

struct __min_fn {
  template <class T, class C = less, class P = identity>
    requires(!requires(T& t) { t.begin(); })
  constexpr const T& operator()(const T& a, const T& b, C comp = {}, P proj = {}) const {
    return std::invoke(comp, std::invoke(proj, b), std::invoke(proj, a)) ? b : a;
  }
  template <class R, class C = less, class P = identity>
    requires requires(R& r) { r.begin(); }
  constexpr auto operator()(R&& range, C comp = {}, P proj = {}) const {
    return *__min_element_fn{}(range, comp, proj);
  }
};
inline constexpr __min_fn min{};

struct __max_fn {
  template <class T, class C = less, class P = identity>
    requires(!requires(T& t) { t.begin(); })
  constexpr const T& operator()(const T& a, const T& b, C comp = {}, P proj = {}) const {
    return std::invoke(comp, std::invoke(proj, a), std::invoke(proj, b)) ? b : a;
  }
  template <class R, class C = less, class P = identity>
    requires requires(R& r) { r.begin(); }
  constexpr auto operator()(R&& range, C comp = {}, P proj = {}) const {
    return *__max_element_fn{}(range, comp, proj);
  }
};
inline constexpr __max_fn max{};

struct __sort_fn {
  template <class R, class C = less, class P = identity>
  constexpr auto operator()(R&& range, C comp = {}, P proj = {}) const {
    auto first = ranges::begin(range);
    auto last = ranges::end(range);
    std::sort(first, last, [&](const auto& a, const auto& b) {
      return static_cast<bool>(std::invoke(comp, std::invoke(proj, a), std::invoke(proj, b)));
    });
    return last;
  }
};
inline constexpr __sort_fn sort{};

struct __stable_sort_fn {
  template <class R, class C = less, class P = identity>
  constexpr auto operator()(R&& range, C comp = {}, P proj = {}) const {
    auto first = ranges::begin(range);
    auto last = ranges::end(range);
    std::stable_sort(first, last, [&](const auto& a, const auto& b) {
      return static_cast<bool>(std::invoke(comp, std::invoke(proj, a), std::invoke(proj, b)));
    });
    return last;
  }
};
inline constexpr __stable_sort_fn stable_sort{};

struct __reverse_fn {
  template <class R>
  constexpr auto operator()(R&& range) const {
    auto first = ranges::begin(range);
    auto last = ranges::end(range);
    auto end = last;
    while (first != last && first != --last) {
      auto value = std::move(*first);
      *first = std::move(*last);
      *last = std::move(value);
      ++first;
    }
    return end;
  }
};
inline constexpr __reverse_fn reverse{};

struct __copy_fn {
  template <class R, class O>
  constexpr auto operator()(R&& range, O out) const {
    auto it = ranges::begin(range);
    for (; it != ranges::end(range); ++it) {
      *out = *it;
      ++out;
    }
    return in_out_result<decltype(it), O>{it, out};
  }
};
inline constexpr __copy_fn copy{};

struct __copy_if_fn {
  template <class R, class O, class F, class P = identity>
  constexpr auto operator()(R&& range, O out, F pred, P proj = {}) const {
    auto it = ranges::begin(range);
    for (; it != ranges::end(range); ++it) {
      if (std::invoke(pred, std::invoke(proj, *it))) {
        *out = *it;
        ++out;
      }
    }
    return in_out_result<decltype(it), O>{it, out};
  }
};
inline constexpr __copy_if_fn copy_if{};

struct __transform_fn {
  template <class R, class O, class F, class P = identity>
  constexpr auto operator()(R&& range, O out, F f, P proj = {}) const {
    auto it = ranges::begin(range);
    for (; it != ranges::end(range); ++it) {
      *out = std::invoke(f, std::invoke(proj, *it));
      ++out;
    }
    return in_out_result<decltype(it), O>{it, out};
  }
};
inline constexpr __transform_fn transform{};

struct __fill_fn {
  template <class R, class T>
  constexpr auto operator()(R&& range, const T& value) const {
    auto it = ranges::begin(range);
    for (; it != ranges::end(range); ++it) *it = value;
    return it;
  }
};
inline constexpr __fill_fn fill{};

struct __equal_fn {
  template <class R1, class R2, class C = equal_to>
  constexpr bool operator()(R1&& a, R2&& b, C comp = {}) const {
    auto i = ranges::begin(a);
    auto j = ranges::begin(b);
    for (; i != ranges::end(a) && j != ranges::end(b); ++i, ++j)
      if (!std::invoke(comp, *i, *j)) return false;
    return !(i != ranges::end(a)) && !(j != ranges::end(b));
  }
};
inline constexpr __equal_fn equal{};

struct __binary_search_fn {
  template <class R, class T, class C = less>
  constexpr bool operator()(R&& range, const T& value, C comp = {}) const {
    return std::binary_search(ranges::begin(range), ranges::end(range), value, comp);
  }
};
inline constexpr __binary_search_fn binary_search{};
}  // namespace ranges

namespace views = ranges::views;
`,
};
