import type { LibrarySource } from '../librarySources';
import { TYPE_TRAITS } from './typeTraits';

/** `<bit>`: the bit operations of unsigned integers, and `std::endian`, which is little on arm64. */
export const BIT: LibrarySource = {
  names: [
    'popcount',
    'has_single_bit',
    'bit_ceil',
    'bit_floor',
    'bit_width',
    'countl_zero',
    'countl_one',
    'countr_zero',
    'countr_one',
    'rotl',
    'rotr',
    'endian',
    'bit_cast',
  ],
  uses: [TYPE_TRAITS],
  source: String.raw`
template <class T>
inline constexpr bool __is_bit_unsigned = is_unsigned_v<T> && !is_same_v<T, bool> && !is_same_v<T, char> &&
                                          !is_same_v<T, char8_t> && !is_same_v<T, char16_t> &&
                                          !is_same_v<T, char32_t> && !is_same_v<T, wchar_t>;

template <class T>
  requires __is_bit_unsigned<T>
constexpr int bit_width(T x) noexcept {
  int width = 0;
  for (; x != 0; x >>= 1) ++width;
  return width;
}
template <class T>
  requires __is_bit_unsigned<T>
constexpr int countl_zero(T x) noexcept {
  return static_cast<int>(sizeof(T)) * 8 - bit_width(x);
}
template <class T>
  requires __is_bit_unsigned<T>
constexpr int countl_one(T x) noexcept {
  return countl_zero(static_cast<T>(~x));
}
template <class T>
  requires __is_bit_unsigned<T>
constexpr int countr_zero(T x) noexcept {
  if (x == 0) return static_cast<int>(sizeof(T)) * 8;
  int count = 0;
  for (; (x & 1) == 0; x >>= 1) ++count;
  return count;
}
template <class T>
  requires __is_bit_unsigned<T>
constexpr int countr_one(T x) noexcept {
  return countr_zero(static_cast<T>(~x));
}
template <class T>
  requires __is_bit_unsigned<T>
constexpr int popcount(T x) noexcept {
  int count = 0;
  for (; x != 0; x >>= 1) count += static_cast<int>(x & 1);
  return count;
}
template <class T>
  requires __is_bit_unsigned<T>
constexpr bool has_single_bit(T x) noexcept {
  return x != 0 && (x & (x - 1)) == 0;
}
template <class T>
  requires __is_bit_unsigned<T>
constexpr T bit_floor(T x) noexcept {
  return x == 0 ? 0 : static_cast<T>(T(1) << (bit_width(x) - 1));
}
template <class T>
  requires __is_bit_unsigned<T>
constexpr T bit_ceil(T x) noexcept {
  if (x <= 1) return 1;
  return static_cast<T>(T(1) << bit_width(static_cast<T>(x - 1)));
}
template <class T>
  requires __is_bit_unsigned<T>
constexpr T rotl(T x, int s) noexcept {
  constexpr int digits = static_cast<int>(sizeof(T)) * 8;
  int r = s % digits;
  if (r == 0) return x;
  if (r < 0) return static_cast<T>((x >> -r) | (x << (digits + r)));
  return static_cast<T>((x << r) | (x >> (digits - r)));
}
template <class T>
  requires __is_bit_unsigned<T>
constexpr T rotr(T x, int s) noexcept {
  constexpr int digits = static_cast<int>(sizeof(T)) * 8;
  int r = s % digits;
  if (r == 0) return x;
  if (r < 0) return static_cast<T>((x << -r) | (x >> (digits + r)));
  return static_cast<T>((x >> r) | (x << (digits - r)));
}

enum class endian { little = 1234, big = 4321, native = little };

// The representations of arithmetic types, which are the same on every platform the interpreter imitates.
template <class To, class From>
  requires(sizeof(To) == sizeof(From))
constexpr To bit_cast(const From& from) noexcept {
  static_assert(is_arithmetic_v<To> && is_arithmetic_v<From>, "std::bit_cast of this type is not supported");
  if constexpr (is_floating_point_v<From>) {
    if constexpr (is_floating_point_v<To>) return from;
    else if constexpr (sizeof(From) == 4) return static_cast<To>(std::__builtin_float_bits(from));
    else return static_cast<To>(std::__builtin_double_bits(from));
  } else if constexpr (is_floating_point_v<To>) {
    if constexpr (sizeof(To) == 4) return std::__builtin_bits_float(static_cast<unsigned>(from));
    else return std::__builtin_bits_double(static_cast<unsigned long long>(from));
  } else {
    return static_cast<To>(from);
  }
}
`,
};
