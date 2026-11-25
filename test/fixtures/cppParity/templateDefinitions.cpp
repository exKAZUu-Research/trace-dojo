#include <iostream>
#include <vector>
#include <string>
template <typename T> T twice(T x) { return x * 2; }
template <class T> T maxOf(const T& a, const T& b) { return a < b ? b : a; }
template <class T, int N> int length(T (&)[N]) { return N; }
template <class T> void print(const std::vector<T>& v) { for (const T& x : v) std::cout << x << " "; std::cout << "\n"; }
template <class T> void show(T x) { std::cout << "generic " << x << "\n"; }
template <class T> void show(T* p) { std::cout << "pointer " << *p << "\n"; }
void show(int x) { std::cout << "int " << x << "\n"; }
template <class T = int, int K = 3> T times(T x) { return x * K; }
template <class T>
class Box {
 public:
  Box(T v) : value(v) {}
  T get() const;
  void set(T v) { value = v; }
  Box<T> doubled() const { return Box(value + value); }
  static int count;
 private:
  T value;
};
template <class T> T Box<T>::get() const { return value; }
template <class T> struct Pair { T first, second; T sum() const { return first + second; } };
template <class T> struct Traits { static const char* name() { return "other"; } };
template <> struct Traits<int> { static const char* name() { return "int"; } };
template <class T> struct Traits<T*> { static const char* name() { return "pointer"; } };
template <class T> using Vec = std::vector<T>;
template <int N> struct Fact { static const int value = N * Fact<N - 1>::value; };
template <> struct Fact<0> { static const int value = 1; };
int main() {
  std::cout << twice(3) << " " << twice(1.5) << " " << twice<long>(4) << "\n";
  std::cout << maxOf(3, 7) << " " << maxOf(std::string("a"), std::string("b")) << "\n";
  int arr[5] = {};
  std::cout << length(arr) << "\n";
  print(std::vector<int>{1, 2, 3});
  Vec<std::string> words = {"x", "y"};
  print(words);
  int n = 5;
  show(2.5); show(&n); show(7);
  std::cout << times(2) << " " << times<double, 2>(1.5) << "\n";
  Box<int> b(4);
  b.set(5);
  std::cout << b.get() << " " << b.doubled().get() << "\n";
  Box<std::string> s("hi");
  std::cout << s.get() << s.doubled().get() << "\n";
  Pair<double> p{1.5, 2.25};
  std::cout << p.sum() << "\n";
  std::cout << Traits<double>::name() << " " << Traits<int>::name() << " " << Traits<char*>::name() << "\n";
  std::cout << Fact<5>::value << "\n";
}
