import type { LibrarySource } from '../librarySources';

export const INITIALIZER_LIST: LibrarySource = {
  names: ['initializer_list'],
  source: String.raw`
template <class E>
class initializer_list {
  const E* __begin = nullptr;
  unsigned long __size = 0;

public:
  using value_type = E;
  using reference = const E&;
  using const_reference = const E&;
  using size_type = unsigned long;
  using iterator = const E*;
  using const_iterator = const E*;

  constexpr initializer_list() noexcept {}
  constexpr initializer_list(const E* first, unsigned long size) noexcept : __begin(first), __size(size) {}
  constexpr unsigned long size() const noexcept { return __size; }
  constexpr const E* begin() const noexcept { return __begin; }
  constexpr const E* end() const noexcept { return __begin + __size; }
};
`,
};
