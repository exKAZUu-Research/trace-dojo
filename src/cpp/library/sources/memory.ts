import type { LibrarySource } from '../librarySources';
import { TYPE_TRAITS } from './typeTraits';

export const MEMORY: LibrarySource = {
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
    'addressof',
  ],
  uses: [TYPE_TRAITS],
  source: String.raw`
template <class T>
constexpr T* addressof(T& value) noexcept {
  return &value;
}

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
