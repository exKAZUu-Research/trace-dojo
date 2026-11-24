import type { LibrarySource } from '../librarySources';

/**
 * `std::exception_ptr` of `<exception>`, which shares an exception object: its address is the object's, whose
 * references the interpreter's natives count, keeping the object alive while one refers to it.
 */
export const EXCEPTION_PTR: LibrarySource = {
  names: ['exception_ptr', 'current_exception', 'rethrow_exception', 'make_exception_ptr'],
  source: String.raw`
class exception_ptr {
public:
  void* __address = nullptr;

  exception_ptr() noexcept {}
  exception_ptr(decltype(nullptr)) noexcept {}
  exception_ptr(const exception_ptr& other) noexcept : __address(other.__address) {
    std::__builtin_exception_retain(__address);
  }
  exception_ptr& operator=(const exception_ptr& other) noexcept {
    std::__builtin_exception_retain(other.__address);
    std::__builtin_exception_release(__address);
    __address = other.__address;
    return *this;
  }
  ~exception_ptr() { std::__builtin_exception_release(__address); }
  explicit operator bool() const noexcept { return __address != nullptr; }
  friend bool operator==(const exception_ptr& a, const exception_ptr& b) noexcept { return a.__address == b.__address; }
  friend bool operator!=(const exception_ptr& a, const exception_ptr& b) noexcept { return a.__address != b.__address; }
};

inline exception_ptr current_exception() noexcept {
  exception_ptr pointer;
  pointer.__address = std::__builtin_current_exception();
  return pointer;
}

[[noreturn]] inline void rethrow_exception(exception_ptr pointer) {
  std::__builtin_rethrow_exception(pointer.__address);
}

template <class E>
exception_ptr make_exception_ptr(E e) noexcept {
  try {
    throw e;
  } catch (...) {
    return current_exception();
  }
}
`,
};
