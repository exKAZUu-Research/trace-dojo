import type { LibrarySource } from '../librarySources';
import { MEMORY } from './memory';
import { TUPLE } from './tuple';
import { TYPE_TRAITS } from './typeTraits';

/** The function objects of `<functional>` other than `std::function`: invoking, wrapping, and binding callables. */
export const INVOKE: LibrarySource = {
  names: [
    'invoke',
    'invoke_r',
    'reference_wrapper',
    'ref',
    'cref',
    'unwrap_reference',
    'unwrap_reference_t',
    'unwrap_ref_decay',
    'unwrap_ref_decay_t',
    'not_fn',
    'mem_fn',
    'bind',
    'bind_front',
    'placeholders',
    'is_bind_expression',
    'is_bind_expression_v',
    'is_placeholder',
    'is_placeholder_v',
    'identity',
  ],
  uses: [TYPE_TRAITS, TUPLE, MEMORY],
  source: String.raw`
template <class T>
class reference_wrapper {
  T* __pointer;

public:
  using type = T;
  reference_wrapper(T& target) noexcept : __pointer(std::addressof(target)) {}
  reference_wrapper(T&&) = delete;
  operator T&() const noexcept { return *__pointer; }
  T& get() const noexcept { return *__pointer; }
  template <class... Args>
  decltype(auto) operator()(Args&&... args) const {
    return std::invoke(get(), std::forward<Args>(args)...);
  }
};
template <class T>
reference_wrapper(T&) -> reference_wrapper<T>;

template <class T>
reference_wrapper<T> ref(T& target) noexcept {
  return reference_wrapper<T>(target);
}
template <class T>
reference_wrapper<T> ref(reference_wrapper<T> wrapper) noexcept {
  return wrapper;
}
template <class T>
void ref(const T&&) = delete;
template <class T>
reference_wrapper<const T> cref(const T& target) noexcept {
  return reference_wrapper<const T>(target);
}
template <class T>
reference_wrapper<const T> cref(reference_wrapper<T> wrapper) noexcept {
  return reference_wrapper<const T>(wrapper.get());
}
template <class T>
void cref(const T&&) = delete;

template <class T>
struct unwrap_reference {
  using type = T;
};
template <class T>
struct unwrap_reference<reference_wrapper<T>> {
  using type = T&;
};
template <class T>
using unwrap_reference_t = typename unwrap_reference<T>::type;
template <class T>
struct unwrap_ref_decay : unwrap_reference<decay_t<T>> {};
template <class T>
using unwrap_ref_decay_t = typename unwrap_ref_decay<T>::type;

template <class T>
struct __is_reference_wrapper : false_type {};
template <class T>
struct __is_reference_wrapper<reference_wrapper<T>> : true_type {};

template <class T>
constexpr decltype(auto) __object_of(T&& object) {
  if constexpr (__is_reference_wrapper<remove_cvref_t<T>>::value) return object.get();
  else if constexpr (is_pointer_v<remove_cvref_t<T>>) return *object;
  else return std::forward<T>(object);
}

template <class F, class T, class... Args>
constexpr decltype(auto) __invoke_member(F member, T&& object, Args&&... args) {
  if constexpr (__is_reference_wrapper<remove_cvref_t<T>>::value) return (object.get().*member)(std::forward<Args>(args)...);
  else if constexpr (is_pointer_v<remove_cvref_t<T>>) return ((*object).*member)(std::forward<Args>(args)...);
  else return (std::forward<T>(object).*member)(std::forward<Args>(args)...);
}
template <class F, class T>
constexpr decltype(auto) __invoke_data(F member, T&& object) {
  if constexpr (__is_reference_wrapper<remove_cvref_t<T>>::value) return object.get().*member;
  else if constexpr (is_pointer_v<remove_cvref_t<T>>) return (*object).*member;
  else return std::forward<T>(object).*member;
}

template <class F, class... Args>
constexpr decltype(auto) invoke(F&& f, Args&&... args) {
  if constexpr (is_member_function_pointer_v<remove_cvref_t<F>>) return __invoke_member(f, std::forward<Args>(args)...);
  else if constexpr (is_member_object_pointer_v<remove_cvref_t<F>>) return __invoke_data(f, std::forward<Args>(args)...);
  else return std::forward<F>(f)(std::forward<Args>(args)...);
}
template <class R, class F, class... Args>
constexpr R invoke_r(F&& f, Args&&... args) {
  if constexpr (is_void_v<R>) std::invoke(std::forward<F>(f), std::forward<Args>(args)...);
  else return std::invoke(std::forward<F>(f), std::forward<Args>(args)...);
}

template <class F>
class __not_fn {
  F __f;

public:
  explicit __not_fn(F f) : __f(std::move(f)) {}
  template <class... Args>
  bool operator()(Args&&... args) {
    return !std::invoke(__f, std::forward<Args>(args)...);
  }
  template <class... Args>
  bool operator()(Args&&... args) const {
    return !std::invoke(__f, std::forward<Args>(args)...);
  }
};
template <class F>
__not_fn<decay_t<F>> not_fn(F&& f) {
  return __not_fn<decay_t<F>>(std::forward<F>(f));
}

template <class M>
class __mem_fn {
  M __member;

public:
  explicit __mem_fn(M member) : __member(member) {}
  template <class... Args>
  decltype(auto) operator()(Args&&... args) const {
    return std::invoke(__member, std::forward<Args>(args)...);
  }
};
template <class M>
__mem_fn<M> mem_fn(M member) noexcept {
  return __mem_fn<M>(member);
}

template <int N>
struct __placeholder {};
namespace placeholders {
inline constexpr __placeholder<1> _1{};
inline constexpr __placeholder<2> _2{};
inline constexpr __placeholder<3> _3{};
inline constexpr __placeholder<4> _4{};
inline constexpr __placeholder<5> _5{};
inline constexpr __placeholder<6> _6{};
inline constexpr __placeholder<7> _7{};
inline constexpr __placeholder<8> _8{};
inline constexpr __placeholder<9> _9{};
inline constexpr __placeholder<10> _10{};
}  // namespace placeholders

template <class T>
struct is_placeholder : integral_constant<int, 0> {};
template <int N>
struct is_placeholder<__placeholder<N>> : integral_constant<int, N> {};
template <class T>
struct is_placeholder<const T> : is_placeholder<T> {};
template <class T>
inline constexpr int is_placeholder_v = is_placeholder<T>::value;

template <class F, class... Bound>
class __bind;
template <class T>
struct is_bind_expression : false_type {};
template <class F, class... Bound>
struct is_bind_expression<__bind<F, Bound...>> : true_type {};
template <class T>
struct is_bind_expression<const T> : is_bind_expression<T> {};
template <class T>
inline constexpr bool is_bind_expression_v = is_bind_expression<T>::value;

template <unsigned long N, class... A>
struct __nth_type;
template <class H, class... R>
struct __nth_type<0, H, R...> {
  using type = H;
};
template <unsigned long N, class H, class... R>
struct __nth_type<N, H, R...> : __nth_type<N - 1, R...> {};

template <unsigned long N, class A, class... R>
constexpr typename __nth_type<N, A, R...>::type&& __nth_argument(A&& first, R&&... rest) {
  if constexpr (N == 0) return std::forward<A>(first);
  else return __nth_argument<N - 1>(std::forward<R>(rest)...);
}

// The argument a bound argument passes: a call argument for a placeholder, the result of a nested bind expression,
// the referent of a reference_wrapper, or else the bound argument itself.
template <class B, class... Args>
constexpr decltype(auto) __bound_argument(B& bound, Args&&... args) {
  if constexpr (is_placeholder_v<B> > 0) return __nth_argument<is_placeholder_v<B> - 1>(std::forward<Args>(args)...);
  else if constexpr (is_bind_expression_v<B>) return bound(std::forward<Args>(args)...);
  else if constexpr (__is_reference_wrapper<remove_cv_t<B>>::value) return bound.get();
  else return (bound);
}

template <class F, class... Bound>
class __bind {
  F __f;
  tuple<Bound...> __bound;

  template <class Self, unsigned long... I, class... Args>
  static decltype(auto) __call(Self& self, index_sequence<I...>, Args&&... args) {
    return std::invoke(self.__f, __bound_argument(std::get<I>(self.__bound), std::forward<Args>(args)...)...);
  }

public:
  template <class G, class... B>
  explicit __bind(G&& f, B&&... bound) : __f(std::forward<G>(f)), __bound(std::forward<B>(bound)...) {}
  template <class... Args>
  decltype(auto) operator()(Args&&... args) {
    return __call(*this, index_sequence_for<Bound...>{}, std::forward<Args>(args)...);
  }
  template <class... Args>
  decltype(auto) operator()(Args&&... args) const {
    return __call(*this, index_sequence_for<Bound...>{}, std::forward<Args>(args)...);
  }
};
template <class F, class... Bound>
__bind<decay_t<F>, decay_t<Bound>...> bind(F&& f, Bound&&... bound) {
  return __bind<decay_t<F>, decay_t<Bound>...>(std::forward<F>(f), std::forward<Bound>(bound)...);
}

template <class F, class... Bound>
class __bind_front {
  F __f;
  tuple<Bound...> __bound;

  template <class Self, unsigned long... I, class... Args>
  static decltype(auto) __call(Self& self, index_sequence<I...>, Args&&... args) {
    return std::invoke(self.__f, std::get<I>(self.__bound)..., std::forward<Args>(args)...);
  }

public:
  template <class G, class... B>
  explicit __bind_front(G&& f, B&&... bound) : __f(std::forward<G>(f)), __bound(std::forward<B>(bound)...) {}
  template <class... Args>
  decltype(auto) operator()(Args&&... args) {
    return __call(*this, index_sequence_for<Bound...>{}, std::forward<Args>(args)...);
  }
  template <class... Args>
  decltype(auto) operator()(Args&&... args) const {
    return __call(*this, index_sequence_for<Bound...>{}, std::forward<Args>(args)...);
  }
};
template <class F, class... Bound>
__bind_front<decay_t<F>, decay_t<Bound>...> bind_front(F&& f, Bound&&... bound) {
  return __bind_front<decay_t<F>, decay_t<Bound>...>(std::forward<F>(f), std::forward<Bound>(bound)...);
}

struct identity {
  template <class T>
  constexpr T&& operator()(T&& value) const noexcept {
    return std::forward<T>(value);
  }
  using is_transparent = void;
};
`,
};
