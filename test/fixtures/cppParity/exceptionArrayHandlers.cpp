#include <iostream>

int main() {
  int values[]{7, 8};
  try { throw values; }
  catch (int items[]) { std::cout << items[0] << '\n'; }

  try { throw values; }
  catch (const int items[2]) { std::cout << items[1] << '\n'; }

  int rows[][2]{{1, 2}, {3, 4}};
  try { throw rows; }
  catch (int items[][2]) { std::cout << items[1][0] << '\n'; }
}
