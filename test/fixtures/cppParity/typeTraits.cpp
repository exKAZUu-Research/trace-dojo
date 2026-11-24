#include <iostream>
#include <type_traits>
#include <string>
struct A { virtual ~A() {} };
struct B : A {};
struct E {};
union U { int i; };
enum class C { X };
template <class T>
std::enable_if_t<std::is_integral_v<T>, const char*> kind(T) { return "integral"; }
template <class T>
std::enable_if_t<std::is_floating_point_v<T>, const char*> kind(T) { return "floating"; }
template <class T>
const char* describe() {
  if constexpr (std::is_pointer_v<T>) return "pointer";
  else if constexpr (std::is_same_v<T, std::string>) return "string";
  else return "other";
}
int main() {
  std::cout << std::boolalpha;
  std::cout << std::is_same<int, int>::value << std::is_same_v<int, long> << "\n";
  std::cout << std::is_integral_v<char> << std::is_integral_v<double> << std::is_floating_point<float>::value << "\n";
  std::cout << kind(3) << " " << kind(2.5) << "\n";
  std::cout << describe<int*>() << " " << describe<std::string>() << " " << describe<int>() << "\n";
  std::cout << std::is_same_v<std::remove_reference_t<int&>, int> << std::is_same_v<std::decay_t<const int&>, int>
            << std::is_same_v<std::decay_t<int[3]>, int*> << "\n";
  std::cout << std::is_base_of_v<A, B> << std::is_base_of_v<B, A> << std::is_polymorphic_v<A> << std::is_class_v<U>
            << std::is_union_v<U> << std::is_enum_v<C> << std::is_empty_v<E> << "\n";
  std::cout << std::is_convertible_v<int, double> << std::is_convertible_v<std::string, int> << "\n";
  std::cout << std::is_same_v<std::common_type_t<int, double>, double> << std::is_signed_v<int>
            << std::is_unsigned_v<unsigned> << std::is_const_v<const int> << "\n";
  std::cout << std::is_same_v<std::conditional_t<true, int, double>, int> << std::rank_v<int[2][3]>
            << std::extent_v<int[2][3], 1> << "\n";
  std::cout << std::is_same_v<std::make_unsigned_t<int>, unsigned> << std::is_default_constructible_v<std::string>
            << std::is_copy_constructible_v<std::string> << std::is_trivially_copyable_v<E> << "\n";
  std::integral_constant<int, 5> five;
  std::cout << five() << " " << decltype(five)::value << " " << std::true_type::value << "\n";
  static_assert(std::is_arithmetic_v<int>);
}
