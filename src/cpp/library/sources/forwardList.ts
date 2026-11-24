import type { LibrarySource } from '../librarySources';
import { TYPE_TRAITS } from './typeTraits';

/**
 * `std::forward_list`, which keeps its elements in a `std::list` so that its iterators are the list's, which the
 * library's algorithms take. Its `before_begin()` is the list's `end()`, which `insert_after` and the other members
 * that take the position before an element treat as the position before the first one.
 */
export const FORWARD_LIST: LibrarySource = {
  names: ['forward_list'],
  uses: [TYPE_TRAITS],
  source: String.raw`
template <class T>
class forward_list {
  std::list<T> __items;

  using __list_iterator = typename std::list<T>::iterator;
  using __list_const_iterator = typename std::list<T>::const_iterator;

  __list_iterator __after(__list_const_iterator position) {
    if (position == __items.cend()) return __items.begin();
    auto it = __items.begin();
    std::advance(it, std::distance(__items.cbegin(), position) + 1);
    return it;
  }

public:
  using value_type = T;
  using size_type = unsigned long;
  using difference_type = long;
  using reference = T&;
  using const_reference = const T&;
  using iterator = __list_iterator;
  using const_iterator = __list_const_iterator;

  forward_list() {}
  explicit forward_list(unsigned long count) : __items(count) {}
  forward_list(unsigned long count, const T& value) : __items(count, value) {}
  forward_list(std::initializer_list<T> values) : __items(values.begin(), values.end()) {}
  template <class It>
    requires(!is_integral_v<It>)
  forward_list(It first, It last) : __items(first, last) {}
  forward_list(const forward_list& other) : __items(other.__items) {}
  forward_list(forward_list&& other) noexcept : __items(std::move(other.__items)) {}
  forward_list& operator=(const forward_list& other) {
    __items = other.__items;
    return *this;
  }
  forward_list& operator=(forward_list&& other) noexcept {
    __items = std::move(other.__items);
    return *this;
  }
  forward_list& operator=(std::initializer_list<T> values) {
    __items.assign(values.begin(), values.end());
    return *this;
  }
  void assign(unsigned long count, const T& value) { __items.assign(count, value); }
  void assign(std::initializer_list<T> values) { __items.assign(values.begin(), values.end()); }
  template <class It>
    requires(!is_integral_v<It>)
  void assign(It first, It last) {
    __items.assign(first, last);
  }

  T& front() { return __items.front(); }
  const T& front() const { return __items.front(); }
  iterator before_begin() noexcept { return __items.end(); }
  const_iterator before_begin() const noexcept { return __items.cend(); }
  const_iterator cbefore_begin() const noexcept { return __items.cend(); }
  iterator begin() noexcept { return __items.begin(); }
  const_iterator begin() const noexcept { return __items.cbegin(); }
  const_iterator cbegin() const noexcept { return __items.cbegin(); }
  iterator end() noexcept { return __items.end(); }
  const_iterator end() const noexcept { return __items.cend(); }
  const_iterator cend() const noexcept { return __items.cend(); }

  [[nodiscard]] bool empty() const noexcept { return __items.empty(); }
  unsigned long max_size() const noexcept { return __items.max_size(); }
  void clear() noexcept { __items.clear(); }
  void push_front(const T& value) { __items.push_front(value); }
  void push_front(T&& value) { __items.push_front(std::move(value)); }
  template <class... Args>
  T& emplace_front(Args&&... args) {
    return __items.emplace_front(std::forward<Args>(args)...);
  }
  void pop_front() { __items.pop_front(); }
  void resize(unsigned long count) { __items.resize(count); }
  void resize(unsigned long count, const T& value) { __items.resize(count, value); }
  void swap(forward_list& other) noexcept { __items.swap(other.__items); }

  iterator insert_after(const_iterator position, const T& value) {
    return __items.insert(__after(position), value);
  }
  iterator insert_after(const_iterator position, T&& value) {
    return __items.insert(__after(position), std::move(value));
  }
  iterator insert_after(const_iterator position, unsigned long count, const T& value) {
    iterator first = __after(position);
    if (count == 0) return first == __items.begin() && position == __items.cend() ? __items.end() : std::prev(first);
    return std::next(__items.insert(first, count, value), static_cast<long>(count) - 1);
  }
  iterator insert_after(const_iterator position, std::initializer_list<T> values) {
    iterator first = __after(position);
    if (values.size() == 0) return position == __items.cend() ? __items.end() : std::prev(first);
    return std::next(__items.insert(first, values.begin(), values.end()), static_cast<long>(values.size()) - 1);
  }
  template <class... Args>
  iterator emplace_after(const_iterator position, Args&&... args) {
    return __items.emplace(__after(position), std::forward<Args>(args)...);
  }
  iterator erase_after(const_iterator position) { return __items.erase(__after(position)); }
  iterator erase_after(const_iterator position, const_iterator last) {
    iterator first = __after(position);
    while (first != __items.end() && first != last) first = __items.erase(first);
    return first;
  }
  void splice_after(const_iterator position, forward_list& other) {
    __items.splice(__after(position), other.__items);
  }
  void splice_after(const_iterator position, forward_list&& other) {
    __items.splice(__after(position), other.__items);
  }

  unsigned long remove(const T& value) { return __items.remove(value); }
  template <class P>
  unsigned long remove_if(P pred) {
    return __items.remove_if(pred);
  }
  unsigned long unique() { return __items.unique(); }
  template <class P>
  unsigned long unique(P pred) {
    return __items.unique(pred);
  }
  void merge(forward_list& other) { __items.merge(other.__items); }
  void merge(forward_list&& other) { __items.merge(other.__items); }
  template <class C>
  void merge(forward_list& other, C comp) {
    __items.merge(other.__items, comp);
  }
  void sort() { __items.sort(); }
  template <class C>
  void sort(C comp) {
    __items.sort(comp);
  }
  void reverse() noexcept { __items.reverse(); }

  friend bool operator==(const forward_list& a, const forward_list& b) { return a.__items == b.__items; }
  friend bool operator!=(const forward_list& a, const forward_list& b) { return a.__items != b.__items; }
  friend bool operator<(const forward_list& a, const forward_list& b) { return a.__items < b.__items; }
  friend bool operator>(const forward_list& a, const forward_list& b) { return b.__items < a.__items; }
  friend bool operator<=(const forward_list& a, const forward_list& b) { return !(b.__items < a.__items); }
  friend bool operator>=(const forward_list& a, const forward_list& b) { return !(a.__items < b.__items); }
};
template <class T>
forward_list(std::initializer_list<T>) -> forward_list<T>;
template <class T>
void swap(forward_list<T>& a, forward_list<T>& b) noexcept {
  a.swap(b);
}
`,
};
