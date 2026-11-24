import type { LibrarySource } from '../librarySources';
import { STRING_VIEW } from './stringView';
import { TYPE_TRAITS } from './typeTraits';

/** `std::hash`, which gives libc++'s hashes: an integer's value, a floating-point number's bits, a string's CityHash64. */
export const HASH: LibrarySource = {
  names: ['hash'],
  uses: [TYPE_TRAITS, STRING_VIEW],
  source: String.raw`
template <class T>
struct hash {
  unsigned long operator()(const T& value) const noexcept {
    if constexpr (is_integral_v<T> || is_enum_v<T>) {
      return static_cast<unsigned long>(value);
    } else if constexpr (is_same_v<T, float>) {
      return std::__builtin_hash_float(value);
    } else if constexpr (is_same_v<T, double>) {
      return std::__builtin_hash_double(value);
    } else if constexpr (is_same_v<T, std::string> || is_same_v<T, std::string_view>) {
      return std::__builtin_hash_bytes(value.data(), value.size());
    } else if constexpr (is_same_v<T, decltype(nullptr)>) {
      return 0;
    } else {
      static_assert(is_integral_v<T>, "std::hash has no specialization for this type");
      return 0;
    }
  }
};
`,
};
