#include <iostream>

struct Base {};
struct Private : private Base {};

int main() {
  try { throw "error"; }
  catch (char*) { std::cout << "mutable\n"; }
  catch (const char* text) { std::cout << text << '\n'; }

  int value = 3;
  int* pointer = &value;
  try { throw &pointer; }
  catch (const int**) { std::cout << "unsafe\n"; }
  catch (const int* const* address) { std::cout << **address << '\n'; }

  try { throw static_cast<const int*>(&value); }
  catch (void*) { std::cout << "non-const\n"; }
  catch (const void*) { std::cout << "const\n"; }

  Private object;
  try { throw &object; }
  catch (Base*) { std::cout << "private base\n"; }
  catch (Private*) { std::cout << "exact pointer\n"; }
}
