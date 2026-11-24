import type { LibrarySource } from '../librarySources';
import { TYPE_TRAITS } from './typeTraits';

/** `std::reverse_iterator` of `<iterator>`, for iterators the library's C++ source and programs define. */
export const REVERSE_ITERATOR: LibrarySource = {
  names: ['reverse_iterator', 'make_reverse_iterator'],
  uses: [TYPE_TRAITS],
  source: String.raw`
template <class It>
class reverse_iterator {
protected:
  It current;

public:
  using iterator_type = It;
  using reference = decltype(*declval<It&>());
  using value_type = remove_cvref_t<reference>;
  using difference_type = decltype(declval<It&>() - declval<It&>());

  constexpr reverse_iterator() : current() {}
  constexpr explicit reverse_iterator(It it) : current(it) {}
  template <class U>
  constexpr reverse_iterator(const reverse_iterator<U>& other) : current(other.base()) {}
  constexpr It base() const { return current; }
  constexpr reference operator*() const {
    It previous = current;
    return *--previous;
  }
  constexpr auto operator->() const {
    It previous = current;
    --previous;
    if constexpr (is_pointer_v<It>) return previous;
    else return previous.operator->();
  }
  constexpr reference operator[](difference_type n) const { return *(*this + n); }
  constexpr reverse_iterator& operator++() {
    --current;
    return *this;
  }
  constexpr reverse_iterator operator++(int) {
    reverse_iterator old = *this;
    --current;
    return old;
  }
  constexpr reverse_iterator& operator--() {
    ++current;
    return *this;
  }
  constexpr reverse_iterator operator--(int) {
    reverse_iterator old = *this;
    ++current;
    return old;
  }
  constexpr reverse_iterator operator+(difference_type n) const { return reverse_iterator(current - n); }
  constexpr reverse_iterator operator-(difference_type n) const { return reverse_iterator(current + n); }
  constexpr reverse_iterator& operator+=(difference_type n) {
    current -= n;
    return *this;
  }
  constexpr reverse_iterator& operator-=(difference_type n) {
    current += n;
    return *this;
  }
};
template <class A, class B>
constexpr bool operator==(const reverse_iterator<A>& a, const reverse_iterator<B>& b) {
  return a.base() == b.base();
}
template <class A, class B>
constexpr bool operator!=(const reverse_iterator<A>& a, const reverse_iterator<B>& b) {
  return a.base() != b.base();
}
template <class A, class B>
constexpr bool operator<(const reverse_iterator<A>& a, const reverse_iterator<B>& b) {
  return a.base() > b.base();
}
template <class A, class B>
constexpr bool operator>(const reverse_iterator<A>& a, const reverse_iterator<B>& b) {
  return a.base() < b.base();
}
template <class A, class B>
constexpr bool operator<=(const reverse_iterator<A>& a, const reverse_iterator<B>& b) {
  return a.base() >= b.base();
}
template <class A, class B>
constexpr bool operator>=(const reverse_iterator<A>& a, const reverse_iterator<B>& b) {
  return a.base() <= b.base();
}
template <class A, class B>
constexpr auto operator-(const reverse_iterator<A>& a, const reverse_iterator<B>& b) {
  return b.base() - a.base();
}
template <class It>
constexpr reverse_iterator<It> operator+(typename reverse_iterator<It>::difference_type n, const reverse_iterator<It>& it) {
  return it + n;
}
template <class It>
constexpr reverse_iterator<It> make_reverse_iterator(It it) {
  return reverse_iterator<It>(it);
}
`,
};

/** `<span>`, a view of a contiguous sequence of objects, whose iterators are pointers. */
export const SPAN: LibrarySource = {
  names: ['span', 'dynamic_extent'],
  uses: [TYPE_TRAITS, REVERSE_ITERATOR],
  source: String.raw`
inline constexpr unsigned long dynamic_extent = static_cast<unsigned long>(-1);

template <class T, unsigned long Extent = dynamic_extent>
class span {
  T* __data = nullptr;
  unsigned long __size = 0;

public:
  using element_type = T;
  using value_type = remove_cv_t<T>;
  using size_type = unsigned long;
  using difference_type = long;
  using pointer = T*;
  using const_pointer = const T*;
  using reference = T&;
  using const_reference = const T&;
  using iterator = T*;
  using reverse_iterator = std::reverse_iterator<T*>;
  static constexpr unsigned long extent = Extent;

  constexpr span() noexcept
    requires(Extent == dynamic_extent || Extent == 0)
  {}
  template <class It>
    requires(!is_integral_v<It>)
  constexpr span(It first, unsigned long count) : __data(count == 0 ? nullptr : &*first), __size(count) {}
  template <class It, class End>
    requires(!is_integral_v<End>)
  constexpr span(It first, End last) : __data(first == last ? nullptr : &*first), __size(last - first) {}
  template <unsigned long N>
    requires(Extent == dynamic_extent || Extent == N)
  constexpr span(type_identity_t<T> (&array)[N]) noexcept : __data(array), __size(N) {}
  template <class R>
    requires(!is_array_v<remove_cvref_t<R>> && requires(R& r) {
      r.data();
      r.size();
    })
  constexpr span(R&& range) : __data(range.data()), __size(range.size()) {}
  template <class U, unsigned long E>
    requires(Extent == dynamic_extent || E == dynamic_extent || Extent == E)
  constexpr span(const span<U, E>& other) noexcept : __data(other.data()), __size(other.size()) {}
  constexpr span(const span&) noexcept = default;
  constexpr span& operator=(const span&) noexcept = default;

  constexpr unsigned long size() const noexcept { return __size; }
  constexpr unsigned long size_bytes() const noexcept { return __size * sizeof(T); }
  [[nodiscard]] constexpr bool empty() const noexcept { return __size == 0; }
  constexpr T* data() const noexcept { return __data; }
  constexpr T& operator[](unsigned long index) const { return __data[index]; }
  constexpr T& front() const { return __data[0]; }
  constexpr T& back() const { return __data[__size - 1]; }
  constexpr T* begin() const noexcept { return __data; }
  constexpr T* end() const noexcept { return __data + __size; }
  constexpr std::reverse_iterator<T*> rbegin() const noexcept { return std::reverse_iterator<T*>(end()); }
  constexpr std::reverse_iterator<T*> rend() const noexcept { return std::reverse_iterator<T*>(begin()); }

  template <unsigned long Count>
  constexpr span<T, Count> first() const {
    return span<T, Count>(__data, Count);
  }
  template <unsigned long Count>
  constexpr span<T, Count> last() const {
    return span<T, Count>(__data + (__size - Count), Count);
  }
  constexpr span<T> first(unsigned long count) const { return span<T>(__data, count); }
  constexpr span<T> last(unsigned long count) const { return span<T>(__data + (__size - count), count); }
  constexpr span<T> subspan(unsigned long offset, unsigned long count = dynamic_extent) const {
    return span<T>(__data + offset, count == dynamic_extent ? __size - offset : count);
  }
};

template <class T, unsigned long N>
span(T (&)[N]) -> span<T, N>;
template <class R>
span(R&&) -> span<remove_reference_t<decltype(*declval<R&>().data())>>;
template <class It, class End>
span(It, End) -> span<remove_reference_t<decltype(*declval<It&>())>>;
`,
};
