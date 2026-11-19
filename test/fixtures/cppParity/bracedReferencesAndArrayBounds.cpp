#include <iostream>
#include <new>

struct Reference { const int& value; };

int main() {
  int n = 2;
  Reference local({n});
  auto heap = new Reference({n});
  n = 3;
  std::cout << local.value << heap->value;
  delete heap;
  int tooSmall = 1;
  try { auto p = new int[tooSmall]{1, 2}; delete[] p; }
  catch (const std::bad_array_new_length&) { std::cout << 'L'; }
  catch (const std::bad_alloc&) { std::cout << 'A'; }
  int negative = -1;
  try { auto p = new int[negative]; delete[] p; }
  catch (const std::bad_alloc&) { std::cout << 'A'; }
}
