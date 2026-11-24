import type { LibrarySource } from '../librarySources';
import { MEMORY } from './memory';
import { TYPE_TRAITS } from './typeTraits';

/**
 * `<filesystem>` on the run's files, as libc++ behaves on POSIX: paths with `/` separators, and errors reported as
 * `std::filesystem::filesystem_error` with libc++'s messages. A directory lists its entries in name order.
 */
export const FILESYSTEM: LibrarySource = {
  names: ['filesystem'],
  uses: [TYPE_TRAITS, MEMORY],
  source: String.raw`
namespace filesystem {

// The elements a path iterates over, which it gives as paths.
template <class P>
class __path_iterator {
  std::vector<std::string> __elements;
  unsigned long __index = 0;

public:
  __path_iterator() {}
  __path_iterator(std::vector<std::string> elements, unsigned long index) : __elements(std::move(elements)), __index(index) {}
  P operator*() const { return P(__elements[__index]); }
  __path_iterator& operator++() {
    ++__index;
    return *this;
  }
  __path_iterator operator++(int) {
    __path_iterator old = *this;
    ++__index;
    return old;
  }
  bool operator==(const __path_iterator& other) const { return __index == other.__index; }
  bool operator!=(const __path_iterator& other) const { return __index != other.__index; }
};

class path {
  std::string __p;

  unsigned long __filename_start() const {
    unsigned long slash = __p.rfind('/');
    return slash == std::string::npos ? 0 : slash + 1;
  }

public:
  using value_type = char;
  using string_type = std::string;
  static constexpr char preferred_separator = '/';

  path() noexcept {}
  path(const std::string& text) : __p(text) {}
  path(const char* text) : __p(text) {}
  path(std::string&& text) : __p(std::move(text)) {}
  path& operator=(const std::string& text) {
    __p = text;
    return *this;
  }
  path& operator=(const char* text) {
    __p = text;
    return *this;
  }

  const std::string& native() const noexcept { return __p; }
  const char* c_str() const noexcept { return __p.c_str(); }
  operator std::string() const { return __p; }
  std::string string() const { return __p; }
  std::string generic_string() const { return __p; }
  bool empty() const noexcept { return __p.empty(); }
  void clear() noexcept { __p.clear(); }

  path& operator/=(const path& other) {
    if (other.is_absolute()) {
      __p = other.__p;
      return *this;
    }
    if (has_filename()) __p += '/';
    __p += other.__p;
    return *this;
  }
  path& append(const path& other) { return *this /= other; }
  path& operator+=(const path& other) {
    __p += other.__p;
    return *this;
  }
  path& operator+=(const std::string& text) {
    __p += text;
    return *this;
  }
  path& operator+=(const char* text) {
    __p += text;
    return *this;
  }
  path& operator+=(char c) {
    __p += c;
    return *this;
  }
  path& concat(const path& other) { return *this += other; }

  path& remove_filename() {
    __p.erase(__filename_start());
    return *this;
  }
  path& replace_filename(const path& replacement) {
    remove_filename();
    return *this /= replacement;
  }
  path& replace_extension(const path& replacement = path()) {
    std::string ext = extension().__p;
    __p.erase(__p.size() - ext.size());
    if (!replacement.empty() && replacement.__p[0] != '.') __p += '.';
    __p += replacement.__p;
    return *this;
  }

  path root_name() const { return path(); }
  path root_directory() const { return is_absolute() ? path("/") : path(); }
  path root_path() const { return root_directory(); }
  path relative_path() const {
    unsigned long start = __p.find_first_not_of('/');
    return start == std::string::npos ? path() : path(__p.substr(start));
  }
  path filename() const { return path(__p.substr(__filename_start())); }
  path parent_path() const {
    if (__p.empty()) return path();
    unsigned long end = __p.back() == '/' ? __p.size() : __filename_start();
    if (end == 0) return path();
    while (end > 1 && __p[end - 1] == '/') --end;
    if (end == 1 && __p[0] == '/') return path("/");
    if (__p.back() == '/' && end == __p.size()) {
      unsigned long last = __p.find_last_not_of('/');
      if (last == std::string::npos) return path("/");
      return path(__p.substr(0, last + 1));
    }
    return path(__p.substr(0, end));
  }
  path stem() const {
    std::string name = filename().__p;
    if (name == "." || name == "..") return path(name);
    unsigned long dot = name.rfind('.');
    return dot == std::string::npos || dot == 0 ? path(name) : path(name.substr(0, dot));
  }
  path extension() const {
    std::string name = filename().__p;
    if (name == "." || name == "..") return path();
    unsigned long dot = name.rfind('.');
    return dot == std::string::npos || dot == 0 ? path() : path(name.substr(dot));
  }

  bool has_root_name() const { return false; }
  bool has_root_directory() const { return is_absolute(); }
  bool has_root_path() const { return is_absolute(); }
  bool has_relative_path() const { return !relative_path().empty(); }
  bool has_parent_path() const { return !parent_path().empty(); }
  bool has_filename() const { return !filename().empty(); }
  bool has_stem() const { return !stem().empty(); }
  bool has_extension() const { return !extension().empty(); }
  bool is_absolute() const { return !__p.empty() && __p[0] == '/'; }
  bool is_relative() const { return !is_absolute(); }

  std::vector<std::string> __elements() const {
    std::vector<std::string> elements;
    unsigned long at = 0;
    if (is_absolute()) {
      elements.push_back("/");
      at = __p.find_first_not_of('/');
      if (at == std::string::npos) return elements;
    }
    while (at < __p.size()) {
      unsigned long slash = __p.find('/', at);
      if (slash == std::string::npos) {
        elements.push_back(__p.substr(at));
        break;
      }
      elements.push_back(__p.substr(at, slash - at));
      at = __p.find_first_not_of('/', slash);
      if (at == std::string::npos) {
        elements.push_back("");
        break;
      }
    }
    return elements;
  }

  path lexically_normal() const {
    if (__p.empty()) return path();
    bool absolute = is_absolute();
    std::vector<std::string> parts;
    for (const std::string& element : __elements())
      if (element != "/") parts.push_back(element);
    bool trailing = !parts.empty() && parts.back().empty();
    if (trailing) parts.pop_back();
    std::vector<std::string> kept;
    for (unsigned long i = 0; i < parts.size(); ++i) {
      bool last = i + 1 == parts.size();
      const std::string& part = parts[i];
      if (part == ".") {
        if (last) trailing = true;
      } else if (part == "..") {
        if (!kept.empty() && kept.back() != "..") {
          kept.pop_back();
          if (last) trailing = true;
        } else if (!absolute) {
          kept.push_back(part);
        }
      } else {
        kept.push_back(part);
      }
    }
    if (!kept.empty() && kept.back() == "..") trailing = false;
    std::string text = absolute ? "/" : "";
    for (unsigned long i = 0; i < kept.size(); ++i) {
      if (i > 0) text += '/';
      text += kept[i];
    }
    if (trailing && !kept.empty()) text += '/';
    if (text.empty()) text = ".";
    return path(text);
  }

  int compare(const path& other) const {
    std::vector<std::string> a = __elements();
    std::vector<std::string> b = other.__elements();
    for (unsigned long i = 0; i < a.size() && i < b.size(); ++i) {
      int order = a[i].compare(b[i]);
      if (order != 0) return order;
    }
    return a.size() < b.size() ? -1 : a.size() > b.size() ? 1 : 0;
  }

  using iterator = __path_iterator<path>;
  iterator begin() const { return iterator(__elements(), 0); }
  iterator end() const {
    std::vector<std::string> elements = __elements();
    unsigned long size = elements.size();
    return iterator(std::move(elements), size);
  }

  friend bool operator==(const path& a, const path& b) { return a.compare(b) == 0; }
  friend bool operator!=(const path& a, const path& b) { return a.compare(b) != 0; }
  friend bool operator<(const path& a, const path& b) { return a.compare(b) < 0; }
  friend bool operator>(const path& a, const path& b) { return a.compare(b) > 0; }
  friend bool operator<=(const path& a, const path& b) { return a.compare(b) <= 0; }
  friend bool operator>=(const path& a, const path& b) { return a.compare(b) >= 0; }
  friend path operator/(const path& a, const path& b) {
    path joined = a;
    joined /= b;
    return joined;
  }
  friend std::ostream& operator<<(std::ostream& out, const path& p) {
    std::string quoted = "\"";
    for (char c : p.__p) {
      if (c == '"' || c == '\\') quoted += '\\';
      quoted += c;
    }
    quoted += '"';
    return out << quoted;
  }
};

class filesystem_error : public std::runtime_error {
  path __path1;
  path __path2;

public:
  filesystem_error(const std::string& what, const path& p1, const path& p2)
      : std::runtime_error(what), __path1(p1), __path2(p2) {}
  const path& path1() const noexcept { return __path1; }
  const path& path2() const noexcept { return __path2; }
};

[[noreturn]] inline void __throw_error(const char* function, long error, const path& p1) {
  throw filesystem_error(std::string("filesystem error: in ") + function + ": " +
                             std::__builtin_fs_error_message(static_cast<int>(-error)) + " [\"" + p1.string() + "\"]",
                         p1, path());
}
[[noreturn]] inline void __throw_error(const char* function, long error, const path& p1, const path& p2) {
  throw filesystem_error(std::string("filesystem error: in ") + function + ": " +
                             std::__builtin_fs_error_message(static_cast<int>(-error)) + " [\"" + p1.string() +
                             "\"] [\"" + p2.string() + "\"]",
                         p1, p2);
}

enum class file_type : signed char { none = 0, not_found = -1, regular = 1, directory = 2, unknown = 8 };
class file_status {
  file_type __type;

public:
  explicit file_status(file_type type = file_type::none) noexcept : __type(type) {}
  file_type type() const noexcept { return __type; }
};
inline file_status status(const path& p) {
  int kind = std::__builtin_fs_status(p.c_str());
  return file_status(kind == 1 ? file_type::regular : kind == 2 ? file_type::directory : file_type::not_found);
}
inline bool exists(file_status s) noexcept { return s.type() != file_type::not_found && s.type() != file_type::none; }
inline bool is_directory(file_status s) noexcept { return s.type() == file_type::directory; }
inline bool is_regular_file(file_status s) noexcept { return s.type() == file_type::regular; }
inline bool exists(const path& p) { return std::__builtin_fs_status(p.c_str()) != 0; }
inline bool is_directory(const path& p) { return std::__builtin_fs_status(p.c_str()) == 2; }
inline bool is_regular_file(const path& p) { return std::__builtin_fs_status(p.c_str()) == 1; }

inline unsigned long long file_size(const path& p) {
  long long size = std::__builtin_fs_file_size(p.c_str());
  if (size < 0) __throw_error("file_size", size, p);
  return static_cast<unsigned long long>(size);
}
inline bool create_directory(const path& p) {
  int result = std::__builtin_fs_create_directory(p.c_str(), false);
  if (result < 0) __throw_error("create_directory", result, p);
  return result == 1;
}
inline bool create_directories(const path& p) {
  int result = std::__builtin_fs_create_directory(p.c_str(), true);
  if (result < 0) __throw_error("create_directories", result, p);
  return result == 1;
}
inline bool remove(const path& p) {
  int result = std::__builtin_fs_remove(p.c_str());
  if (result < 0) __throw_error("remove", result, p);
  return result == 1;
}
inline unsigned long long remove_all(const path& p) {
  long long result = std::__builtin_fs_remove_all(p.c_str());
  if (result < 0) __throw_error("remove_all", result, p);
  return static_cast<unsigned long long>(result);
}
inline void rename(const path& from, const path& to) {
  int result = std::__builtin_fs_rename(from.c_str(), to.c_str());
  if (result < 0) __throw_error("rename", result, from, to);
}
inline void resize_file(const path& p, unsigned long long size) {
  int result = std::__builtin_fs_resize_file(p.c_str(), size);
  if (result < 0) __throw_error("resize_file", result, p);
}

enum class copy_options : unsigned short {
  none = 0,
  skip_existing = 1,
  overwrite_existing = 2,
  update_existing = 4,
  recursive = 8,
  copy_symlinks = 16,
  skip_symlinks = 32,
  directories_only = 64,
  create_symlinks = 128,
  create_hard_links = 256,
};
constexpr copy_options operator|(copy_options a, copy_options b) {
  return static_cast<copy_options>(static_cast<unsigned short>(a) | static_cast<unsigned short>(b));
}
constexpr copy_options operator&(copy_options a, copy_options b) {
  return static_cast<copy_options>(static_cast<unsigned short>(a) & static_cast<unsigned short>(b));
}
constexpr bool __has(copy_options options, copy_options flag) { return (options & flag) != copy_options::none; }

inline bool copy_file(const path& from, const path& to, copy_options options = copy_options::none) {
  int mode = __has(options, copy_options::skip_existing) ? 1
             : __has(options, copy_options::overwrite_existing) || __has(options, copy_options::update_existing) ? 2
                                                                                                                : 0;
  int result = std::__builtin_fs_copy_file(from.c_str(), to.c_str(), mode);
  if (result < 0) __throw_error("copy_file", result, to, from);
  return result == 1;
}

class directory_entry {
  filesystem::path __path;

public:
  directory_entry() noexcept {}
  explicit directory_entry(const filesystem::path& p) : __path(p) {}
  const filesystem::path& path() const noexcept { return __path; }
  operator const filesystem::path&() const noexcept { return __path; }
  bool exists() const { return filesystem::exists(__path); }
  bool is_directory() const { return filesystem::is_directory(__path); }
  bool is_regular_file() const { return filesystem::is_regular_file(__path); }
  unsigned long long file_size() const { return filesystem::file_size(__path); }
  file_status status() const { return filesystem::status(__path); }
  bool operator==(const directory_entry& other) const { return __path == other.__path; }
  bool operator<(const directory_entry& other) const { return __path < other.__path; }
  friend std::ostream& operator<<(std::ostream& out, const directory_entry& entry) { return out << entry.__path; }
};

inline std::vector<directory_entry> __entries(const path& directory, const char* function) {
  int kind = std::__builtin_fs_status(directory.c_str());
  if (kind != 2) __throw_error(function, kind == 0 ? -2 : -20, directory);
  std::string names = std::__builtin_fs_list(directory.c_str());
  std::vector<directory_entry> entries;
  unsigned long at = 0;
  while (!names.empty() && at <= names.size()) {
    unsigned long slash = names.find('/', at);
    if (slash == std::string::npos) slash = names.size();
    entries.push_back(directory_entry(directory / path(names.substr(at, slash - at))));
    at = slash + 1;
  }
  return entries;
}

class directory_iterator {
  std::shared_ptr<std::vector<directory_entry>> __entries_;
  unsigned long __index = 0;

public:
  directory_iterator() noexcept {}
  explicit directory_iterator(const path& directory)
      : __entries_(std::make_shared<std::vector<directory_entry>>(
            __entries(directory, "directory_iterator::directory_iterator(...)"))) {}
  const directory_entry& operator*() const { return (*__entries_)[__index]; }
  const directory_entry* operator->() const { return &(*__entries_)[__index]; }
  directory_iterator& operator++() {
    ++__index;
    return *this;
  }
  directory_iterator& increment() { return ++*this; }
  bool __at_end() const { return !__entries_ || __index >= __entries_->size(); }
  friend bool operator==(const directory_iterator& a, const directory_iterator& b) {
    if (a.__at_end() || b.__at_end()) return a.__at_end() && b.__at_end();
    return a.__entries_ == b.__entries_ && a.__index == b.__index;
  }
  friend bool operator!=(const directory_iterator& a, const directory_iterator& b) { return !(a == b); }
};
inline directory_iterator begin(directory_iterator it) noexcept { return it; }
inline directory_iterator end(directory_iterator) noexcept { return directory_iterator(); }

class recursive_directory_iterator {
  std::shared_ptr<std::vector<std::pair<directory_entry, int>>> __entries_;
  unsigned long __index = 0;

  static void __collect(std::vector<std::pair<directory_entry, int>>& out, const path& directory, int depth) {
    for (const directory_entry& entry : __entries(directory, "recursive_directory_iterator::recursive_directory_iterator(...)")) {
      out.push_back({entry, depth});
      if (entry.is_directory()) __collect(out, entry.path(), depth + 1);
    }
  }

public:
  recursive_directory_iterator() noexcept {}
  explicit recursive_directory_iterator(const path& directory)
      : __entries_(std::make_shared<std::vector<std::pair<directory_entry, int>>>()) {
    __collect(*__entries_, directory, 0);
  }
  const directory_entry& operator*() const { return (*__entries_)[__index].first; }
  const directory_entry* operator->() const { return &(*__entries_)[__index].first; }
  int depth() const { return (*__entries_)[__index].second; }
  recursive_directory_iterator& operator++() {
    ++__index;
    return *this;
  }
  recursive_directory_iterator& increment() { return ++*this; }
  bool __at_end() const { return !__entries_ || __index >= __entries_->size(); }
  friend bool operator==(const recursive_directory_iterator& a, const recursive_directory_iterator& b) {
    if (a.__at_end() || b.__at_end()) return a.__at_end() && b.__at_end();
    return a.__entries_ == b.__entries_ && a.__index == b.__index;
  }
  friend bool operator!=(const recursive_directory_iterator& a, const recursive_directory_iterator& b) {
    return !(a == b);
  }
};
inline recursive_directory_iterator begin(recursive_directory_iterator it) noexcept { return it; }
inline recursive_directory_iterator end(recursive_directory_iterator) noexcept { return recursive_directory_iterator(); }

inline bool is_empty(const path& p) {
  int kind = std::__builtin_fs_status(p.c_str());
  if (kind == 0) __throw_error("is_empty", -2, p);
  if (kind == 1) return file_size(p) == 0;
  return std::__builtin_fs_list(p.c_str()).empty();
}

inline void copy(const path& from, const path& to, copy_options options = copy_options::none) {
  int kind = std::__builtin_fs_status(from.c_str());
  if (kind == 0) __throw_error("copy", -2, from, to);
  if (kind == 1) {
    path target = is_directory(to) ? to / from.filename() : to;
    copy_file(from, target, options);
    return;
  }
  if (std::__builtin_fs_status(to.c_str()) == 1) __throw_error("copy", -17, from, to);
  create_directory(to);
  for (const directory_entry& entry : __entries(from, "copy")) {
    if (entry.is_directory() && !__has(options, copy_options::recursive)) continue;
    copy(entry.path(), to / entry.path().filename(), options);
  }
}

inline path current_path() { return path("/"); }
inline path absolute(const path& p) { return p.is_absolute() ? p : current_path() / p; }
inline path canonical(const path& p) {
  if (!exists(p)) __throw_error("canonical", -2, p);
  path normal = absolute(p).lexically_normal();
  std::string text = normal.string();
  if (text.size() > 1 && text.back() == '/') text.pop_back();
  return path(text);
}
inline path weakly_canonical(const path& p) {
  path normal = absolute(p).lexically_normal();
  std::string text = normal.string();
  if (text.size() > 1 && text.back() == '/') text.pop_back();
  return path(text);
}
inline bool equivalent(const path& a, const path& b) {
  if (!exists(a) || !exists(b)) __throw_error("equivalent", -2, a, b);
  return canonical(a) == canonical(b);
}
}  // namespace filesystem
`,
};
