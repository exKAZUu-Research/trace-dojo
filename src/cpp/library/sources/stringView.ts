import type { LibrarySource } from '../librarySources';

export const STRING_VIEW: LibrarySource = {
  names: ['string_view', 'literals', 'string_view_literals'],
  source: String.raw`
class string_view {
  const char* __data = nullptr;
  unsigned long __size = 0;

  static constexpr unsigned long __length(const char* s) {
    unsigned long n = 0;
    while (s[n] != '\0') ++n;
    return n;
  }

public:
  using value_type = char;
  using size_type = unsigned long;
  using const_iterator = const char*;
  using iterator = const char*;
  static constexpr unsigned long npos = -1;

  constexpr string_view() noexcept {}
  constexpr string_view(const char* s) : __data(s), __size(__length(s)) {}
  constexpr string_view(const char* s, unsigned long n) : __data(s), __size(n) {}
  string_view(const std::string& s) noexcept : __data(s.data()), __size(s.size()) {}
  string_view(nullptr_t) = delete;
  operator std::string() const { return std::string(__data, __size); }

  constexpr const char* begin() const noexcept { return __data; }
  constexpr const char* end() const noexcept { return __data + __size; }
  constexpr const char* cbegin() const noexcept { return __data; }
  constexpr const char* cend() const noexcept { return __data + __size; }
  constexpr unsigned long size() const noexcept { return __size; }
  constexpr unsigned long length() const noexcept { return __size; }
  constexpr bool empty() const noexcept { return __size == 0; }
  constexpr const char* data() const noexcept { return __data; }
  constexpr const char& operator[](unsigned long i) const { return __data[i]; }
  constexpr const char& at(unsigned long i) const {
    if (i >= __size) throw std::out_of_range("string_view::at");
    return __data[i];
  }
  constexpr const char& front() const { return __data[0]; }
  constexpr const char& back() const { return __data[__size - 1]; }

  constexpr void remove_prefix(unsigned long n) {
    __data += n;
    __size -= n;
  }
  constexpr void remove_suffix(unsigned long n) { __size -= n; }
  constexpr void swap(string_view& other) noexcept {
    string_view moved = *this;
    *this = other;
    other = moved;
  }
  unsigned long copy(char* dest, unsigned long n, unsigned long pos = 0) const {
    if (pos > __size) throw std::out_of_range("string_view::copy");
    unsigned long count = n < __size - pos ? n : __size - pos;
    for (unsigned long i = 0; i < count; ++i) dest[i] = __data[pos + i];
    return count;
  }
  constexpr string_view substr(unsigned long pos = 0, unsigned long n = npos) const {
    if (pos > __size) throw std::out_of_range("string_view::substr");
    return string_view(__data + pos, n < __size - pos ? n : __size - pos);
  }

  constexpr int compare(string_view other) const noexcept {
    unsigned long n = __size < other.__size ? __size : other.__size;
    for (unsigned long i = 0; i < n; ++i) {
      if (__data[i] != other.__data[i]) return (unsigned char)__data[i] < (unsigned char)other.__data[i] ? -1 : 1;
    }
    return __size == other.__size ? 0 : __size < other.__size ? -1 : 1;
  }
  constexpr int compare(unsigned long pos, unsigned long n, string_view other) const {
    return substr(pos, n).compare(other);
  }
  constexpr bool starts_with(string_view prefix) const noexcept {
    return __size >= prefix.__size && substr(0, prefix.__size).compare(prefix) == 0;
  }
  constexpr bool starts_with(char c) const noexcept { return !empty() && front() == c; }
  constexpr bool ends_with(string_view suffix) const noexcept {
    return __size >= suffix.__size && substr(__size - suffix.__size).compare(suffix) == 0;
  }
  constexpr bool ends_with(char c) const noexcept { return !empty() && back() == c; }

  constexpr unsigned long find(string_view s, unsigned long pos = 0) const noexcept {
    if (s.__size > __size) return npos;
    for (unsigned long i = pos; i + s.__size <= __size; ++i)
      if (substr(i, s.__size).compare(s) == 0) return i;
    return npos;
  }
  constexpr unsigned long find(char c, unsigned long pos = 0) const noexcept {
    for (unsigned long i = pos; i < __size; ++i)
      if (__data[i] == c) return i;
    return npos;
  }
  constexpr unsigned long rfind(string_view s, unsigned long pos = npos) const noexcept {
    if (s.__size > __size) return npos;
    unsigned long start = __size - s.__size < pos ? __size - s.__size : pos;
    for (unsigned long i = start + 1; i-- > 0;)
      if (substr(i, s.__size).compare(s) == 0) return i;
    return npos;
  }
  constexpr unsigned long rfind(char c, unsigned long pos = npos) const noexcept {
    if (__size == 0) return npos;
    unsigned long start = __size - 1 < pos ? __size - 1 : pos;
    for (unsigned long i = start + 1; i-- > 0;)
      if (__data[i] == c) return i;
    return npos;
  }
  constexpr unsigned long find_first_of(string_view s, unsigned long pos = 0) const noexcept {
    for (unsigned long i = pos; i < __size; ++i)
      if (s.find(__data[i]) != npos) return i;
    return npos;
  }
  constexpr unsigned long find_first_of(char c, unsigned long pos = 0) const noexcept { return find(c, pos); }
  constexpr unsigned long find_last_of(string_view s, unsigned long pos = npos) const noexcept {
    if (__size == 0) return npos;
    unsigned long start = __size - 1 < pos ? __size - 1 : pos;
    for (unsigned long i = start + 1; i-- > 0;)
      if (s.find(__data[i]) != npos) return i;
    return npos;
  }
  constexpr unsigned long find_last_of(char c, unsigned long pos = npos) const noexcept { return rfind(c, pos); }
  constexpr unsigned long find_first_not_of(string_view s, unsigned long pos = 0) const noexcept {
    for (unsigned long i = pos; i < __size; ++i)
      if (s.find(__data[i]) == npos) return i;
    return npos;
  }
  constexpr unsigned long find_last_not_of(string_view s, unsigned long pos = npos) const noexcept {
    if (__size == 0) return npos;
    unsigned long start = __size - 1 < pos ? __size - 1 : pos;
    for (unsigned long i = start + 1; i-- > 0;)
      if (s.find(__data[i]) == npos) return i;
    return npos;
  }

  friend constexpr bool operator==(string_view a, string_view b) noexcept { return a.compare(b) == 0; }
  friend constexpr bool operator!=(string_view a, string_view b) noexcept { return a.compare(b) != 0; }
  friend constexpr bool operator<(string_view a, string_view b) noexcept { return a.compare(b) < 0; }
  friend constexpr bool operator>(string_view a, string_view b) noexcept { return a.compare(b) > 0; }
  friend constexpr bool operator<=(string_view a, string_view b) noexcept { return a.compare(b) <= 0; }
  friend constexpr bool operator>=(string_view a, string_view b) noexcept { return a.compare(b) >= 0; }
  friend std::ostream& operator<<(std::ostream& os, string_view s) {
    for (unsigned long i = 0; i < s.__size; ++i) os << s.__data[i];
    return os;
  }
};

inline namespace literals {
inline namespace string_view_literals {
constexpr string_view operator""sv(const char* s, unsigned long n) noexcept { return string_view(s, n); }
}
}
`,
};
