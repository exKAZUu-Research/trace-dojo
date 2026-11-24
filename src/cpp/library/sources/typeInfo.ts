import type { LibrarySource } from '../librarySources';

export const TYPE_INFO: LibrarySource = {
  names: ['type_info'],
  source: String.raw`
class type_info {
  const char* __name;

  static int __compare(const char* a, const char* b) noexcept {
    while (*a != '\0' && *a == *b) {
      ++a;
      ++b;
    }
    return (unsigned char)*a - (unsigned char)*b;
  }

public:
  explicit constexpr type_info(const char* name) noexcept : __name(name) {}
  type_info(const type_info&) = delete;
  type_info& operator=(const type_info&) = delete;
  virtual ~type_info() {}

  const char* name() const noexcept { return __name; }
  bool before(const type_info& other) const noexcept { return __compare(__name, other.__name) < 0; }
  unsigned long hash_code() const noexcept {
    unsigned long hash = 14695981039346656037UL;
    for (const char* c = __name; *c != '\0'; ++c) hash = (hash ^ (unsigned char)*c) * 1099511628211UL;
    return hash;
  }
  bool operator==(const type_info& other) const noexcept { return __compare(__name, other.__name) == 0; }
  bool operator!=(const type_info& other) const noexcept { return !(*this == other); }
};
`,
};
