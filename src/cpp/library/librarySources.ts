/**
 * The parts of the standard library the interpreter defines in C++ itself, each with the names of `std` it declares.
 * They are compiled as members of `std` when a program first names one of them, and their code records no steps.
 */
export interface LibrarySource {
  readonly names: readonly string[];
  readonly source: string;
  /** The other parts whose names this part's code uses, which are compiled before it. */
  readonly uses?: readonly LibrarySource[];
}

/** The type traits of one type that a builtin of the same name with `__` before it answers. */
const TRAITS = [
  'is_void',
  'is_null_pointer',
  'is_integral',
  'is_floating_point',
  'is_arithmetic',
  'is_pointer',
  'is_lvalue_reference',
  'is_rvalue_reference',
  'is_reference',
  'is_const',
  'is_array',
  'is_bounded_array',
  'is_unbounded_array',
  'is_function',
  'is_enum',
  'is_scoped_enum',
  'is_class',
  'is_union',
  'is_signed',
  'is_unsigned',
  'is_destructible',
  'is_polymorphic',
  'is_abstract',
  'is_final',
  'is_empty',
  'is_aggregate',
  'is_standard_layout',
  'is_trivially_copyable',
  'is_trivial',
];
const BINARY_TRAITS = ['is_base_of', 'is_convertible', 'is_assignable'];

const TYPE_TRAITS: LibrarySource = {
  names: [
    'integral_constant',
    'bool_constant',
    'true_type',
    'false_type',
    'is_same',
    'is_same_v',
    'conditional',
    'conditional_t',
    'enable_if',
    'enable_if_t',
    'void_t',
    'type_identity',
    'type_identity_t',
    'conjunction',
    'conjunction_v',
    'disjunction',
    'disjunction_v',
    'negation',
    'negation_v',
    'remove_const',
    'remove_const_t',
    'remove_volatile',
    'remove_volatile_t',
    'remove_cv',
    'remove_cv_t',
    'remove_reference',
    'remove_reference_t',
    'remove_cvref',
    'remove_cvref_t',
    'remove_pointer',
    'remove_pointer_t',
    'remove_extent',
    'remove_extent_t',
    'remove_all_extents',
    'remove_all_extents_t',
    'add_const',
    'add_const_t',
    'add_volatile',
    'add_volatile_t',
    'add_cv',
    'add_cv_t',
    'add_pointer',
    'add_pointer_t',
    'add_lvalue_reference',
    'add_lvalue_reference_t',
    'add_rvalue_reference',
    'add_rvalue_reference_t',
    'decay',
    'decay_t',
    'declval',
    'common_type',
    'common_type_t',
    'make_signed',
    'make_signed_t',
    'make_unsigned',
    'make_unsigned_t',
    'rank',
    'rank_v',
    'extent',
    'extent_v',
    'invoke_result',
    'invoke_result_t',
    'is_invocable',
    'is_invocable_v',
    'is_invocable_r',
    'is_invocable_r_v',
    'is_constructible',
    'is_constructible_v',
    'is_default_constructible',
    'is_default_constructible_v',
    'is_copy_constructible',
    'is_copy_constructible_v',
    'is_move_constructible',
    'is_move_constructible_v',
    'is_copy_assignable',
    'is_copy_assignable_v',
    'is_move_assignable',
    'is_move_assignable_v',
    'is_fundamental',
    'is_fundamental_v',
    'is_scalar',
    'is_scalar_v',
    'is_object',
    'is_object_v',
    'is_compound',
    'is_compound_v',
    'is_volatile',
    'is_volatile_v',
    ...[...TRAITS, ...BINARY_TRAITS].flatMap((trait) => [trait, `${trait}_v`]),
  ],
  source: String.raw`
template <class T, T v>
struct integral_constant {
  static constexpr T value = v;
  using value_type = T;
  using type = integral_constant;
  constexpr operator value_type() const noexcept { return value; }
  constexpr value_type operator()() const noexcept { return value; }
};
template <bool B>
using bool_constant = integral_constant<bool, B>;
using true_type = bool_constant<true>;
using false_type = bool_constant<false>;

template <class T, class U> struct is_same : false_type {};
template <class T> struct is_same<T, T> : true_type {};
template <class T, class U> inline constexpr bool is_same_v = is_same<T, U>::value;

template <bool B, class T, class F> struct conditional { using type = T; };
template <class T, class F> struct conditional<false, T, F> { using type = F; };
template <bool B, class T, class F> using conditional_t = typename conditional<B, T, F>::type;

template <bool B, class T = void> struct enable_if {};
template <class T> struct enable_if<true, T> { using type = T; };
template <bool B, class T = void> using enable_if_t = typename enable_if<B, T>::type;

template <class...> using void_t = void;
template <class T> struct type_identity { using type = T; };
template <class T> using type_identity_t = typename type_identity<T>::type;

template <class... B> struct conjunction : true_type {};
template <class B> struct conjunction<B> : bool_constant<bool(B::value)> {};
template <class B, class... R> struct conjunction<B, R...> : conditional_t<bool(B::value), conjunction<R...>, B> {};
template <class... B> inline constexpr bool conjunction_v = conjunction<B...>::value;
template <class... B> struct disjunction : false_type {};
template <class B> struct disjunction<B> : bool_constant<bool(B::value)> {};
template <class B, class... R> struct disjunction<B, R...> : conditional_t<bool(B::value), B, disjunction<R...>> {};
template <class... B> inline constexpr bool disjunction_v = disjunction<B...>::value;
template <class B> struct negation : bool_constant<!bool(B::value)> {};
template <class B> inline constexpr bool negation_v = negation<B>::value;

template <class T> struct remove_const { using type = T; };
template <class T> struct remove_const<const T> { using type = T; };
template <class T> using remove_const_t = typename remove_const<T>::type;
template <class T> struct remove_volatile { using type = T; };
template <class T> using remove_volatile_t = typename remove_volatile<T>::type;
template <class T> struct remove_cv { using type = remove_volatile_t<remove_const_t<T>>; };
template <class T> using remove_cv_t = typename remove_cv<T>::type;
template <class T> struct remove_reference { using type = T; };
template <class T> struct remove_reference<T&> { using type = T; };
template <class T> struct remove_reference<T&&> { using type = T; };
template <class T> using remove_reference_t = typename remove_reference<T>::type;
template <class T> struct remove_cvref { using type = remove_cv_t<remove_reference_t<T>>; };
template <class T> using remove_cvref_t = typename remove_cvref<T>::type;
template <class T> struct remove_pointer { using type = T; };
template <class T> struct remove_pointer<T*> { using type = T; };
template <class T> struct remove_pointer<T* const> { using type = T; };
template <class T> using remove_pointer_t = typename remove_pointer<T>::type;
template <class T> struct remove_extent { using type = T; };
template <class T> struct remove_extent<T[]> { using type = T; };
template <class T, unsigned long N> struct remove_extent<T[N]> { using type = T; };
template <class T> using remove_extent_t = typename remove_extent<T>::type;
template <class T> struct remove_all_extents { using type = T; };
template <class T> struct remove_all_extents<T[]> { using type = typename remove_all_extents<T>::type; };
template <class T, unsigned long N> struct remove_all_extents<T[N]> { using type = typename remove_all_extents<T>::type; };
template <class T> using remove_all_extents_t = typename remove_all_extents<T>::type;

template <class T> struct add_const { using type = const T; };
template <class T> using add_const_t = typename add_const<T>::type;
template <class T> struct add_volatile { using type = volatile T; };
template <class T> using add_volatile_t = typename add_volatile<T>::type;
template <class T> struct add_cv { using type = const volatile T; };
template <class T> using add_cv_t = typename add_cv<T>::type;
template <class T> struct add_pointer { using type = remove_reference_t<T>*; };
template <class T> using add_pointer_t = typename add_pointer<T>::type;
template <class T> struct add_lvalue_reference { using type = T&; };
template <> struct add_lvalue_reference<void> { using type = void; };
template <class T> using add_lvalue_reference_t = typename add_lvalue_reference<T>::type;
template <class T> struct add_rvalue_reference { using type = T&&; };
template <> struct add_rvalue_reference<void> { using type = void; };
template <class T> using add_rvalue_reference_t = typename add_rvalue_reference<T>::type;

template <class T> add_rvalue_reference_t<T> declval() noexcept;

template <class T>
struct decay {
  using __plain = remove_reference_t<T>;
  using type = conditional_t<(__is_array(__plain)), remove_extent_t<__plain>*,
                             conditional_t<(__is_function(__plain)), __plain*, remove_cv_t<__plain>>>;
};
template <class T> using decay_t = typename decay<T>::type;

template <class... T> struct common_type {};
template <class T> struct common_type<T> { using type = decay_t<T>; };
template <class T, class U>
struct common_type<T, U> { using type = decay_t<decltype(true ? declval<decay_t<T>>() : declval<decay_t<U>>())>; };
template <class T, class U, class... R>
struct common_type<T, U, R...> { using type = typename common_type<typename common_type<T, U>::type, R...>::type; };
template <class... T> using common_type_t = typename common_type<T...>::type;

template <class T> struct __sign_change { using __signed = T; using __unsigned = T; };
template <> struct __sign_change<char> { using __signed = signed char; using __unsigned = unsigned char; };
template <> struct __sign_change<signed char> { using __signed = signed char; using __unsigned = unsigned char; };
template <> struct __sign_change<unsigned char> { using __signed = signed char; using __unsigned = unsigned char; };
template <> struct __sign_change<short> { using __signed = short; using __unsigned = unsigned short; };
template <> struct __sign_change<unsigned short> { using __signed = short; using __unsigned = unsigned short; };
template <> struct __sign_change<int> { using __signed = int; using __unsigned = unsigned; };
template <> struct __sign_change<unsigned> { using __signed = int; using __unsigned = unsigned; };
template <> struct __sign_change<long> { using __signed = long; using __unsigned = unsigned long; };
template <> struct __sign_change<unsigned long> { using __signed = long; using __unsigned = unsigned long; };
template <> struct __sign_change<long long> { using __signed = long long; using __unsigned = unsigned long long; };
template <> struct __sign_change<unsigned long long> { using __signed = long long; using __unsigned = unsigned long long; };
template <class T> struct make_signed { using type = typename __sign_change<T>::__signed; };
template <class T> struct make_signed<const T> { using type = const typename __sign_change<T>::__signed; };
template <class T> using make_signed_t = typename make_signed<T>::type;
template <class T> struct make_unsigned { using type = typename __sign_change<T>::__unsigned; };
template <class T> struct make_unsigned<const T> { using type = const typename __sign_change<T>::__unsigned; };
template <class T> using make_unsigned_t = typename make_unsigned<T>::type;

template <class T> struct rank : integral_constant<unsigned long, 0> {};
template <class T> struct rank<T[]> : integral_constant<unsigned long, rank<T>::value + 1> {};
template <class T, unsigned long N> struct rank<T[N]> : integral_constant<unsigned long, rank<T>::value + 1> {};
template <class T> inline constexpr unsigned long rank_v = rank<T>::value;
template <class T, unsigned I = 0> struct extent : integral_constant<unsigned long, 0> {};
template <class T> struct extent<T[], 0> : integral_constant<unsigned long, 0> {};
template <class T, unsigned I> struct extent<T[], I> : extent<T, I - 1> {};
template <class T, unsigned long N> struct extent<T[N], 0> : integral_constant<unsigned long, N> {};
template <class T, unsigned long N, unsigned I> struct extent<T[N], I> : extent<T, I - 1> {};
template <class T, unsigned I = 0> inline constexpr unsigned long extent_v = extent<T, I>::value;

template <class F, class... Args> struct invoke_result { using type = decltype(declval<F>()(declval<Args>()...)); };
template <class F, class... Args> using invoke_result_t = typename invoke_result<F, Args...>::type;
template <class F, class... Args>
concept __invocable = requires(F f, Args... args) { f(args...); };
template <class F, class... Args> struct is_invocable : bool_constant<__invocable<F, Args...>> {};
template <class F, class... Args> inline constexpr bool is_invocable_v = is_invocable<F, Args...>::value;
template <class R, class F, class... Args>
concept __invocable_r = requires(F f, Args... args) { { f(args...) } -> std::convertible_to<R>; };
template <class R, class F, class... Args> struct is_invocable_r : bool_constant<__invocable_r<R, F, Args...>> {};
template <class R, class F, class... Args> inline constexpr bool is_invocable_r_v = is_invocable_r<R, F, Args...>::value;
${TRAITS.map(
  (trait) => `template <class T> struct ${trait} : bool_constant<(__${trait}(T))> {};
template <class T> inline constexpr bool ${trait}_v = __${trait}(T);`
).join('\n')}
${BINARY_TRAITS.map(
  (trait) => `template <class T, class U> struct ${trait} : bool_constant<(__${trait}(T, U))> {};
template <class T, class U> inline constexpr bool ${trait}_v = __${trait}(T, U);`
).join('\n')}
template <class T, class... Args> struct is_constructible : bool_constant<(__is_constructible(T, Args...))> {};
template <class T, class... Args> inline constexpr bool is_constructible_v = __is_constructible(T, Args...);
template <class T> struct is_default_constructible : bool_constant<(__is_constructible(T))> {};
template <class T> inline constexpr bool is_default_constructible_v = __is_constructible(T);
template <class T> struct is_copy_constructible : bool_constant<(__is_constructible(T, add_lvalue_reference_t<const T>))> {};
template <class T> inline constexpr bool is_copy_constructible_v = is_copy_constructible<T>::value;
template <class T> struct is_move_constructible : bool_constant<(__is_constructible(T, add_rvalue_reference_t<T>))> {};
template <class T> inline constexpr bool is_move_constructible_v = is_move_constructible<T>::value;
template <class T> struct is_copy_assignable
    : bool_constant<(__is_assignable(add_lvalue_reference_t<T>, add_lvalue_reference_t<const T>))> {};
template <class T> inline constexpr bool is_copy_assignable_v = is_copy_assignable<T>::value;
template <class T> struct is_move_assignable
    : bool_constant<(__is_assignable(add_lvalue_reference_t<T>, add_rvalue_reference_t<T>))> {};
template <class T> inline constexpr bool is_move_assignable_v = is_move_assignable<T>::value;
template <class T> struct is_fundamental : bool_constant<(__is_arithmetic(T) || __is_void(T) || __is_null_pointer(T))> {};
template <class T> inline constexpr bool is_fundamental_v = is_fundamental<T>::value;
template <class T> struct is_scalar
    : bool_constant<(__is_arithmetic(T) || __is_enum(T) || __is_pointer(T) || __is_null_pointer(T))> {};
template <class T> inline constexpr bool is_scalar_v = is_scalar<T>::value;
template <class T> struct is_object
    : bool_constant<!__is_function(T) && !__is_reference(T) && !__is_void(T)> {};
template <class T> inline constexpr bool is_object_v = is_object<T>::value;
template <class T> struct is_compound : bool_constant<!is_fundamental<T>::value> {};
template <class T> inline constexpr bool is_compound_v = is_compound<T>::value;
template <class T> struct is_volatile : false_type {};
template <class T> inline constexpr bool is_volatile_v = false;
`,
};

const OPTIONAL: LibrarySource = {
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

const FUNCTION: LibrarySource = {
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

const MEMORY: LibrarySource = {
  names: [
    'default_delete',
    'unique_ptr',
    'make_unique',
    'shared_ptr',
    'weak_ptr',
    'make_shared',
    'enable_shared_from_this',
    'static_pointer_cast',
    'dynamic_pointer_cast',
    'const_pointer_cast',
  ],
  uses: [TYPE_TRAITS],
  source: String.raw`
template <class T>
struct default_delete {
  constexpr default_delete() noexcept = default;
  template <class U>
  default_delete(const default_delete<U>&) noexcept {}
  void operator()(T* p) const { delete p; }
};
template <class T>
struct default_delete<T[]> {
  constexpr default_delete() noexcept = default;
  void operator()(T* p) const { delete[] p; }
};

template <class T, class D = default_delete<T>>
class unique_ptr : private D {
  T* __ptr = nullptr;
  template <class, class> friend class unique_ptr;

public:
  using pointer = T*;
  using element_type = T;
  using deleter_type = D;

  constexpr unique_ptr() noexcept {}
  constexpr unique_ptr(nullptr_t) noexcept {}
  explicit unique_ptr(T* p) noexcept : __ptr(p) {}
  unique_ptr(T* p, const D& d) noexcept : D(d), __ptr(p) {}
  unique_ptr(unique_ptr&& other) noexcept : D(std::move(other.get_deleter())), __ptr(other.release()) {}
  template <class U, class E>
    requires(is_convertible_v<U*, T*>)
  unique_ptr(unique_ptr<U, E>&& other) noexcept : D(std::move(other.get_deleter())), __ptr(other.release()) {}
  unique_ptr(const unique_ptr&) = delete;
  ~unique_ptr() { reset(); }

  unique_ptr& operator=(unique_ptr&& other) noexcept {
    reset(other.release());
    get_deleter() = std::move(other.get_deleter());
    return *this;
  }
  template <class U, class E>
    requires(is_convertible_v<U*, T*>)
  unique_ptr& operator=(unique_ptr<U, E>&& other) noexcept {
    reset(other.release());
    return *this;
  }
  unique_ptr& operator=(nullptr_t) noexcept {
    reset();
    return *this;
  }
  unique_ptr& operator=(const unique_ptr&) = delete;

  T* release() noexcept {
    T* p = __ptr;
    __ptr = nullptr;
    return p;
  }
  void reset(T* p = nullptr) noexcept {
    T* old = __ptr;
    __ptr = p;
    if (old) get_deleter()(old);
  }
  void swap(unique_ptr& other) noexcept {
    T* p = __ptr;
    __ptr = other.__ptr;
    other.__ptr = p;
  }

  T* get() const noexcept { return __ptr; }
  D& get_deleter() noexcept { return *this; }
  const D& get_deleter() const noexcept { return *this; }
  explicit operator bool() const noexcept { return __ptr != nullptr; }
  add_lvalue_reference_t<T> operator*() const { return *__ptr; }
  T* operator->() const noexcept { return __ptr; }
};

template <class T, class D>
class unique_ptr<T[], D> : private D {
  T* __ptr = nullptr;

public:
  using pointer = T*;
  using element_type = T;
  using deleter_type = D;

  constexpr unique_ptr() noexcept {}
  constexpr unique_ptr(nullptr_t) noexcept {}
  explicit unique_ptr(T* p) noexcept : __ptr(p) {}
  unique_ptr(unique_ptr&& other) noexcept : __ptr(other.release()) {}
  unique_ptr(const unique_ptr&) = delete;
  ~unique_ptr() { reset(); }

  unique_ptr& operator=(unique_ptr&& other) noexcept {
    reset(other.release());
    return *this;
  }
  unique_ptr& operator=(nullptr_t) noexcept {
    reset();
    return *this;
  }
  unique_ptr& operator=(const unique_ptr&) = delete;

  T* release() noexcept {
    T* p = __ptr;
    __ptr = nullptr;
    return p;
  }
  void reset(T* p = nullptr) noexcept {
    T* old = __ptr;
    __ptr = p;
    if (old) get_deleter()(old);
  }
  void swap(unique_ptr& other) noexcept {
    T* p = __ptr;
    __ptr = other.__ptr;
    other.__ptr = p;
  }

  T* get() const noexcept { return __ptr; }
  D& get_deleter() noexcept { return *this; }
  const D& get_deleter() const noexcept { return *this; }
  explicit operator bool() const noexcept { return __ptr != nullptr; }
  T& operator[](unsigned long i) const { return __ptr[i]; }
};

template <class T, class... Args>
  requires(!is_array_v<T>)
unique_ptr<T> make_unique(Args&&... args) {
  return unique_ptr<T>(new T(std::forward<Args>(args)...));
}
template <class T>
  requires(is_unbounded_array_v<T>)
unique_ptr<T> make_unique(unsigned long n) {
  return unique_ptr<T>(new remove_extent_t<T>[n]());
}

template <class T, class D, class U, class E>
bool operator==(const unique_ptr<T, D>& a, const unique_ptr<U, E>& b) { return a.get() == b.get(); }
template <class T, class D, class U, class E>
bool operator!=(const unique_ptr<T, D>& a, const unique_ptr<U, E>& b) { return a.get() != b.get(); }
template <class T, class D>
bool operator==(const unique_ptr<T, D>& a, nullptr_t) noexcept { return !a; }
template <class T, class D>
bool operator!=(const unique_ptr<T, D>& a, nullptr_t) noexcept { return static_cast<bool>(a); }
template <class T, class D>
void swap(unique_ptr<T, D>& a, unique_ptr<T, D>& b) noexcept { a.swap(b); }

struct __shared_count {
  long __uses = 1;
  long __weaks = 0;
  virtual ~__shared_count() {}
  virtual void __dispose() noexcept = 0;
};
template <class T, class D>
struct __shared_count_of final : __shared_count {
  T* __owned;
  D __deleter;
  __shared_count_of(T* p, D d) : __owned(p), __deleter(std::move(d)) {}
  void __dispose() noexcept override { __deleter(__owned); }
};

template <class T> class weak_ptr;
template <class T> class enable_shared_from_this;

template <class T>
class shared_ptr {
  remove_extent_t<T>* __ptr = nullptr;
  __shared_count* __count = nullptr;
  template <class> friend class shared_ptr;
  template <class> friend class weak_ptr;

  void __release() noexcept {
    if (__count && --__count->__uses == 0) {
      // The owners keep the count alive while the object's destructor may release weak pointers to it.
      ++__count->__weaks;
      __count->__dispose();
      if (--__count->__weaks == 0) delete __count;
    }
  }
  template <class Y>
  void __enable_weak_this(Y* p) noexcept {
    if constexpr (requires { p->__weak_this; }) {
      if (p && p->__weak_this.expired()) p->__weak_this = shared_ptr<remove_cv_t<Y>>(*this, const_cast<remove_cv_t<Y>*>(p));
    }
  }

public:
  using element_type = remove_extent_t<T>;
  using weak_type = weak_ptr<T>;

  constexpr shared_ptr() noexcept {}
  constexpr shared_ptr(nullptr_t) noexcept {}
  template <class Y>
    requires(is_convertible_v<Y*, element_type*>)
  explicit shared_ptr(Y* p) : __ptr(p), __count(new __shared_count_of<Y, default_delete<conditional_t<is_array_v<T>, Y[], Y>>>(p, {})) {
    __enable_weak_this(p);
  }
  template <class Y, class D>
    requires(is_convertible_v<Y*, element_type*>)
  shared_ptr(Y* p, D d) : __ptr(p), __count(new __shared_count_of<Y, D>(p, std::move(d))) {
    __enable_weak_this(p);
  }
  template <class Y>
  shared_ptr(const shared_ptr<Y>& owner, element_type* p) noexcept : __ptr(p), __count(owner.__count) {
    if (__count) ++__count->__uses;
  }
  shared_ptr(const shared_ptr& other) noexcept : __ptr(other.__ptr), __count(other.__count) {
    if (__count) ++__count->__uses;
  }
  template <class Y>
    requires(is_convertible_v<Y*, element_type*>)
  shared_ptr(const shared_ptr<Y>& other) noexcept : __ptr(other.__ptr), __count(other.__count) {
    if (__count) ++__count->__uses;
  }
  shared_ptr(shared_ptr&& other) noexcept : __ptr(other.__ptr), __count(other.__count) {
    other.__ptr = nullptr;
    other.__count = nullptr;
  }
  template <class Y>
    requires(is_convertible_v<Y*, element_type*>)
  shared_ptr(shared_ptr<Y>&& other) noexcept : __ptr(other.__ptr), __count(other.__count) {
    other.__ptr = nullptr;
    other.__count = nullptr;
  }
  template <class Y>
    requires(is_convertible_v<Y*, element_type*>)
  explicit shared_ptr(const weak_ptr<Y>& weak) : __ptr(weak.__ptr), __count(weak.__count) {
    if (!__count || __count->__uses == 0) throw std::bad_weak_ptr();
    ++__count->__uses;
  }
  template <class Y, class D>
    requires(is_convertible_v<Y*, element_type*>)
  shared_ptr(unique_ptr<Y, D>&& owner) : shared_ptr() {
    if (Y* p = owner.get()) {
      __count = new __shared_count_of<Y, D>(p, owner.get_deleter());
      __ptr = owner.release();
      __enable_weak_this(p);
    }
  }
  ~shared_ptr() { __release(); }

  shared_ptr& operator=(const shared_ptr& other) noexcept {
    shared_ptr(other).swap(*this);
    return *this;
  }
  template <class Y>
  shared_ptr& operator=(const shared_ptr<Y>& other) noexcept {
    shared_ptr(other).swap(*this);
    return *this;
  }
  shared_ptr& operator=(shared_ptr&& other) noexcept {
    shared_ptr(std::move(other)).swap(*this);
    return *this;
  }
  template <class Y>
  shared_ptr& operator=(shared_ptr<Y>&& other) noexcept {
    shared_ptr(std::move(other)).swap(*this);
    return *this;
  }
  template <class Y, class D>
  shared_ptr& operator=(unique_ptr<Y, D>&& other) {
    shared_ptr(std::move(other)).swap(*this);
    return *this;
  }

  void reset() noexcept { shared_ptr().swap(*this); }
  template <class Y>
  void reset(Y* p) { shared_ptr(p).swap(*this); }
  template <class Y, class D>
  void reset(Y* p, D d) { shared_ptr(p, d).swap(*this); }
  void swap(shared_ptr& other) noexcept {
    element_type* p = __ptr;
    __ptr = other.__ptr;
    other.__ptr = p;
    __shared_count* count = __count;
    __count = other.__count;
    other.__count = count;
  }

  element_type* get() const noexcept { return __ptr; }
  add_lvalue_reference_t<element_type> operator*() const noexcept { return *__ptr; }
  element_type* operator->() const noexcept { return __ptr; }
  element_type& operator[](long i) const { return __ptr[i]; }
  long use_count() const noexcept { return __count ? __count->__uses : 0; }
  explicit operator bool() const noexcept { return __ptr != nullptr; }
  template <class Y>
  bool owner_before(const shared_ptr<Y>& other) const noexcept { return __count < other.__count; }
};

template <class T>
shared_ptr(weak_ptr<T>) -> shared_ptr<T>;
template <class T, class D>
shared_ptr(unique_ptr<T, D>) -> shared_ptr<T>;

template <class T>
class weak_ptr {
  T* __ptr = nullptr;
  __shared_count* __count = nullptr;
  template <class> friend class shared_ptr;
  template <class> friend class weak_ptr;

  void __release() noexcept {
    if (__count && --__count->__weaks == 0 && __count->__uses == 0) delete __count;
  }

public:
  using element_type = T;

  constexpr weak_ptr() noexcept {}
  weak_ptr(const weak_ptr& other) noexcept : __ptr(other.__ptr), __count(other.__count) {
    if (__count) ++__count->__weaks;
  }
  template <class Y>
    requires(is_convertible_v<Y*, T*>)
  weak_ptr(const weak_ptr<Y>& other) noexcept : __ptr(other.__ptr), __count(other.__count) {
    if (__count) ++__count->__weaks;
  }
  template <class Y>
    requires(is_convertible_v<Y*, T*>)
  weak_ptr(const shared_ptr<Y>& owner) noexcept : __ptr(owner.__ptr), __count(owner.__count) {
    if (__count) ++__count->__weaks;
  }
  weak_ptr(weak_ptr&& other) noexcept : __ptr(other.__ptr), __count(other.__count) {
    other.__ptr = nullptr;
    other.__count = nullptr;
  }
  ~weak_ptr() { __release(); }

  weak_ptr& operator=(const weak_ptr& other) noexcept {
    weak_ptr(other).swap(*this);
    return *this;
  }
  template <class Y>
  weak_ptr& operator=(const shared_ptr<Y>& owner) noexcept {
    weak_ptr(owner).swap(*this);
    return *this;
  }
  weak_ptr& operator=(weak_ptr&& other) noexcept {
    weak_ptr(std::move(other)).swap(*this);
    return *this;
  }

  void reset() noexcept { weak_ptr().swap(*this); }
  void swap(weak_ptr& other) noexcept {
    T* p = __ptr;
    __ptr = other.__ptr;
    other.__ptr = p;
    __shared_count* count = __count;
    __count = other.__count;
    other.__count = count;
  }
  long use_count() const noexcept { return __count ? __count->__uses : 0; }
  bool expired() const noexcept { return use_count() == 0; }
  shared_ptr<T> lock() const noexcept { return expired() ? shared_ptr<T>() : shared_ptr<T>(*this); }
};

template <class T>
weak_ptr(shared_ptr<T>) -> weak_ptr<T>;

template <class T>
class enable_shared_from_this {
public:
  mutable weak_ptr<T> __weak_this;

protected:
  constexpr enable_shared_from_this() noexcept {}
  enable_shared_from_this(const enable_shared_from_this&) noexcept {}
  enable_shared_from_this& operator=(const enable_shared_from_this&) noexcept { return *this; }
  ~enable_shared_from_this() {}

public:
  shared_ptr<T> shared_from_this() { return shared_ptr<T>(__weak_this); }
  shared_ptr<const T> shared_from_this() const { return shared_ptr<const T>(__weak_this); }
  weak_ptr<T> weak_from_this() noexcept { return __weak_this; }
};

template <class T, class... Args>
  requires(!is_array_v<T>)
shared_ptr<T> make_shared(Args&&... args) {
  return shared_ptr<T>(new T(std::forward<Args>(args)...));
}

template <class T, class U>
shared_ptr<T> static_pointer_cast(const shared_ptr<U>& p) noexcept {
  return shared_ptr<T>(p, static_cast<T*>(p.get()));
}
template <class T, class U>
shared_ptr<T> dynamic_pointer_cast(const shared_ptr<U>& p) noexcept {
  T* cast = dynamic_cast<T*>(p.get());
  return cast ? shared_ptr<T>(p, cast) : shared_ptr<T>();
}
template <class T, class U>
shared_ptr<T> const_pointer_cast(const shared_ptr<U>& p) noexcept {
  return shared_ptr<T>(p, const_cast<T*>(p.get()));
}

template <class T, class U>
bool operator==(const shared_ptr<T>& a, const shared_ptr<U>& b) noexcept { return a.get() == b.get(); }
template <class T, class U>
bool operator!=(const shared_ptr<T>& a, const shared_ptr<U>& b) noexcept { return a.get() != b.get(); }
template <class T, class U>
bool operator<(const shared_ptr<T>& a, const shared_ptr<U>& b) noexcept { return a.get() < b.get(); }
template <class T>
bool operator==(const shared_ptr<T>& a, nullptr_t) noexcept { return !a; }
template <class T>
bool operator!=(const shared_ptr<T>& a, nullptr_t) noexcept { return static_cast<bool>(a); }
template <class T>
void swap(shared_ptr<T>& a, shared_ptr<T>& b) noexcept { a.swap(b); }
template <class T>
void swap(weak_ptr<T>& a, weak_ptr<T>& b) noexcept { a.swap(b); }
`,
};

export const LIBRARY_SOURCES: readonly LibrarySource[] = [TYPE_TRAITS, OPTIONAL, FUNCTION, MEMORY];

const SOURCE_BY_NAME = new Map(LIBRARY_SOURCES.flatMap((source) => source.names.map((name) => [name, source])));

/** The part of the library's C++ source that declares `std::name`, if any. */
export function librarySourceDeclaring(name: string): LibrarySource | undefined {
  return SOURCE_BY_NAME.get(name);
}
