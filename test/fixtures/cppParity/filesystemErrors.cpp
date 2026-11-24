#include <filesystem>
#include <fstream>
#include <iostream>
namespace fs = std::filesystem;
void attempt(const char* label, auto f) {
  try { f(); std::cout << label << " ok\n"; } catch (const fs::filesystem_error& e) { std::cout << label << ": " << e.what() << " | " << e.path1() << " " << e.path2() << "\n"; }
}
int main() {
  fs::create_directory("d");
  attempt("file_size", [] { fs::file_size("nope.txt"); });
  attempt("file_size dir", [] { fs::file_size("d"); });
  attempt("create_directory", [] { fs::create_directory("x/y"); });
  attempt("remove", [] { std::ofstream("d/f.txt") << "hi"; fs::remove("d"); });
  attempt("rename", [] { fs::rename("missing", "other"); });
  attempt("copy_file", [] { fs::copy_file("d/f.txt", "d/f.txt"); });
  attempt("copy_file2", [] { fs::copy_file("nope", "z"); });
  attempt("dir_iter", [] { fs::directory_iterator it("nodir"); });
  attempt("remove_all", [] { std::cout << fs::remove_all("d") << " "; });
  attempt("create_directories", [] { std::ofstream("f") << "x"; fs::create_directories("f/g"); });
}
