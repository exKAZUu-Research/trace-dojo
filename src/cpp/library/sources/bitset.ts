import type { LibrarySource } from '../librarySources';

export const BITSET: LibrarySource = {
  names: ['bitset'],
  source: String.raw`
template <unsigned long N>
class bitset {
  static constexpr unsigned long __words = N == 0 ? 1 : (N + 63) / 64;
  unsigned long __w[__words] = {};

  constexpr void __trim() noexcept {
    if (N % 64 != 0) __w[__words - 1] &= (1UL << (N % 64)) - 1;
  }
  void __check(unsigned long pos, const char* what) const {
    if (pos >= N) throw std::out_of_range(what);
  }
  template <class S>
  void __assign(const S& s, unsigned long length, char zero, char one) {
    unsigned long count = length < N ? length : N;
    for (unsigned long i = 0; i < count; ++i) {
      char c = s[i];
      if (c != zero && c != one) throw std::invalid_argument("bitset string ctor has invalid argument");
    }
    for (unsigned long i = 0; i < count; ++i) set(count - 1 - i, s[i] == one);
  }

public:
  class reference {
    bitset* __b;
    unsigned long __i;
    friend class bitset;
    constexpr reference(bitset* b, unsigned long i) noexcept : __b(b), __i(i) {}

  public:
    reference(const reference&) = default;
    constexpr reference& operator=(bool value) noexcept {
      __b->set(__i, value);
      return *this;
    }
    constexpr reference& operator=(const reference& other) noexcept {
      __b->set(__i, bool(other));
      return *this;
    }
    constexpr operator bool() const noexcept { return __b->test(__i); }
    constexpr bool operator~() const noexcept { return !__b->test(__i); }
    constexpr reference& flip() noexcept {
      __b->flip(__i);
      return *this;
    }
  };

  constexpr bitset() noexcept {}
  constexpr bitset(unsigned long long value) noexcept {
    __w[0] = value;
    __trim();
  }
  explicit bitset(const std::string& s, unsigned long pos = 0, unsigned long n = -1, char zero = '0', char one = '1') {
    if (pos > s.size()) throw std::out_of_range("bitset string pos out of range");
    unsigned long length = s.size() - pos < n ? s.size() - pos : n;
    __assign(s.substr(pos, length), length, zero, one);
  }
  explicit bitset(const char* s, unsigned long n = -1, char zero = '0', char one = '1') {
    unsigned long length = 0;
    while (length < n && s[length] != '\0') ++length;
    __assign(s, length, zero, one);
  }

  constexpr bool test(unsigned long pos) const {
    __check(pos, "bitset test argument out of range");
    return (__w[pos / 64] >> (pos % 64)) & 1;
  }
  constexpr bool operator[](unsigned long pos) const { return (__w[pos / 64] >> (pos % 64)) & 1; }
  constexpr reference operator[](unsigned long pos) { return reference(this, pos); }

  constexpr bitset& set() noexcept {
    for (unsigned long i = 0; i < __words; ++i) __w[i] = ~0UL;
    __trim();
    return *this;
  }
  constexpr bitset& set(unsigned long pos, bool value = true) {
    __check(pos, "bitset set argument out of range");
    if (value) __w[pos / 64] |= 1UL << (pos % 64);
    else __w[pos / 64] &= ~(1UL << (pos % 64));
    return *this;
  }
  constexpr bitset& reset() noexcept {
    for (unsigned long i = 0; i < __words; ++i) __w[i] = 0;
    return *this;
  }
  constexpr bitset& reset(unsigned long pos) {
    __check(pos, "bitset reset argument out of range");
    __w[pos / 64] &= ~(1UL << (pos % 64));
    return *this;
  }
  constexpr bitset& flip() noexcept {
    for (unsigned long i = 0; i < __words; ++i) __w[i] = ~__w[i];
    __trim();
    return *this;
  }
  constexpr bitset& flip(unsigned long pos) {
    __check(pos, "bitset flip argument out of range");
    __w[pos / 64] ^= 1UL << (pos % 64);
    return *this;
  }

  constexpr unsigned long count() const noexcept {
    unsigned long total = 0;
    for (unsigned long i = 0; i < __words; ++i)
      for (unsigned long w = __w[i]; w != 0; w &= w - 1) ++total;
    return total;
  }
  constexpr unsigned long size() const noexcept { return N; }
  constexpr bool any() const noexcept { return count() != 0; }
  constexpr bool none() const noexcept { return count() == 0; }
  constexpr bool all() const noexcept { return count() == N; }

  constexpr unsigned long to_ulong() const {
    for (unsigned long i = 1; i < __words; ++i)
      if (__w[i] != 0) throw std::overflow_error("__bitset<_N_words, _Size>::to_ulong overflow error");
    return __w[0];
  }
  constexpr unsigned long long to_ullong() const {
    for (unsigned long i = 1; i < __words; ++i)
      if (__w[i] != 0) throw std::overflow_error("__bitset<_N_words, _Size>::to_ullong overflow error");
    return __w[0];
  }
  std::string to_string(char zero = '0', char one = '1') const {
    std::string s(N, zero);
    for (unsigned long i = 0; i < N; ++i)
      if ((*this)[i]) s[N - 1 - i] = one;
    return s;
  }

  constexpr bitset& operator&=(const bitset& other) noexcept {
    for (unsigned long i = 0; i < __words; ++i) __w[i] &= other.__w[i];
    return *this;
  }
  constexpr bitset& operator|=(const bitset& other) noexcept {
    for (unsigned long i = 0; i < __words; ++i) __w[i] |= other.__w[i];
    return *this;
  }
  constexpr bitset& operator^=(const bitset& other) noexcept {
    for (unsigned long i = 0; i < __words; ++i) __w[i] ^= other.__w[i];
    return *this;
  }
  constexpr bitset& operator<<=(unsigned long shift) noexcept {
    if (shift >= N) return reset();
    for (unsigned long i = N; i-- > shift;) set(i, (*this)[i - shift]);
    for (unsigned long i = 0; i < shift; ++i) set(i, false);
    return *this;
  }
  constexpr bitset& operator>>=(unsigned long shift) noexcept {
    if (shift >= N) return reset();
    for (unsigned long i = 0; i + shift < N; ++i) set(i, (*this)[i + shift]);
    for (unsigned long i = N - shift; i < N; ++i) set(i, false);
    return *this;
  }
  constexpr bitset operator~() const noexcept { return bitset(*this).flip(); }
  constexpr bitset operator<<(unsigned long shift) const noexcept { return bitset(*this) <<= shift; }
  constexpr bitset operator>>(unsigned long shift) const noexcept { return bitset(*this) >>= shift; }
  constexpr bool operator==(const bitset& other) const noexcept {
    for (unsigned long i = 0; i < __words; ++i)
      if (__w[i] != other.__w[i]) return false;
    return true;
  }
};

template <unsigned long N>
constexpr bitset<N> operator&(const bitset<N>& a, const bitset<N>& b) noexcept {
  return bitset<N>(a) &= b;
}
template <unsigned long N>
constexpr bitset<N> operator|(const bitset<N>& a, const bitset<N>& b) noexcept {
  return bitset<N>(a) |= b;
}
template <unsigned long N>
constexpr bitset<N> operator^(const bitset<N>& a, const bitset<N>& b) noexcept {
  return bitset<N>(a) ^= b;
}
template <unsigned long N>
std::ostream& operator<<(std::ostream& os, const bitset<N>& b) {
  return os << b.to_string();
}
template <unsigned long N>
std::istream& operator>>(std::istream& is, bitset<N>& b) {
  std::string read;
  char c;
  while (read.size() < N && is.get(c)) {
    if (read.empty() && (c == ' ' || c == '\n' || c == '\t')) continue;
    if (c != '0' && c != '1') {
      is.unget();
      break;
    }
    read += c;
  }
  if (read.empty()) is.setstate(std::ios_base::failbit);
  else b = bitset<N>(read);
  return is;
}
`,
};
