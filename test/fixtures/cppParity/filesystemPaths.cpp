#include <algorithm>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>
namespace fs = std::filesystem;
int main() {
  fs::path p = "data/reports/2024.summary.txt";
  std::cout << p << " " << p.filename() << " " << p.stem() << " " << p.extension() << " " << p.parent_path() << "\n";
  std::cout << p.parent_path().parent_path() << " " << p.has_extension() << p.is_relative() << p.is_absolute() << "\n";
  fs::path q = fs::path("/usr") / "local" / "bin/";
  std::cout << q << " " << q.filename() << " " << q.parent_path() << " " << q.root_directory() << q.relative_path() << "\n";
  std::cout << fs::path("a/./b/../c//d/").lexically_normal() << " " << fs::path("../x/..").lexically_normal() << " "
            << fs::path("/../a").lexically_normal() << " " << fs::path("a/..").lexically_normal() << "\n";
  fs::path r = "notes.md";
  r.replace_extension(".txt");
  std::cout << r << " " << fs::path("dir/file").replace_filename("other") << " " << fs::path("x.tar.gz").stem() << "\n";
  for (const auto& part : fs::path("/a/b/c.txt")) std::cout << "[" << part.string() << "]";
  std::cout << "\n";
  std::cout << (fs::path("a/b") == fs::path("a//b")) << (fs::path("a") < fs::path("b")) << "\n";
  fs::create_directories("work/sub/deep");
  std::ofstream("work/a.txt") << "hello";
  std::ofstream("work/b.txt") << "hi there";
  std::ofstream("work/sub/c.log") << "";
  std::cout << fs::exists("work") << fs::is_directory("work") << fs::is_regular_file("work/a.txt") << fs::exists("nope") << "\n";
  std::cout << fs::file_size("work/b.txt") << fs::is_empty("work/sub/c.log") << fs::is_empty("work/sub/deep") << "\n";
  std::vector<std::string> names;
  for (const auto& entry : fs::directory_iterator("work")) names.push_back(entry.path().filename().string() + (entry.is_directory() ? "/" : ""));
  std::sort(names.begin(), names.end());
  for (const auto& n : names) std::cout << n << " ";
  std::cout << "\n";
  std::vector<std::string> all;
  for (const auto& entry : fs::recursive_directory_iterator("work")) all.push_back(entry.path().string());
  std::sort(all.begin(), all.end());
  for (const auto& n : all) std::cout << n << " ";
  std::cout << "\n";
  std::cout << fs::copy_file("work/a.txt", "work/a2.txt") << fs::copy_file("work/a.txt", "work/a2.txt", fs::copy_options::skip_existing) << "\n";
  fs::rename("work/a2.txt", "work/sub/moved.txt");
  std::cout << fs::exists("work/a2.txt") << fs::exists("work/sub/moved.txt") << "\n";
  std::cout << fs::remove("work/b.txt") << fs::remove("work/b.txt") << "\n";
  fs::copy("work", "backup", fs::copy_options::recursive);
  std::cout << fs::exists("backup/sub/moved.txt") << fs::exists("backup/sub/deep") << "\n";
  std::cout << fs::remove_all("work") << " " << fs::remove_all("backup") << " " << fs::exists("work") << "\n";
  std::cout << fs::create_directory("solo") << fs::create_directory("solo") << fs::remove("solo") << "\n";
}
