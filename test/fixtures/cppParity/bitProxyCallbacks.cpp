#include <algorithm>
#include <iostream>
#include <numeric>
#include <vector>

void toggle(std::vector<bool>::reference bit) { bit.flip(); }
bool set(std::vector<bool>::reference bit) { return bit; }
bool same(std::vector<bool>::reference a, std::vector<bool>::reference b) { return a == b; }
bool less(std::vector<bool>::reference a, std::vector<bool>::reference b) { return a < b; }
bool lessValue(std::vector<bool>::reference a, bool value) { return a < value; }
bool greaterBit(bool a, bool b) { return a > b; }
std::vector<bool>::reference expose(std::vector<bool>::reference bit) { return bit; }
int bitToInt(std::vector<bool>::reference bit) { return bit ? 2 : 0; }
int addBit(int sum, std::vector<bool>::reference bit) { return sum + bit; }
void increment(int& value) { ++value; }

struct Flag {
  bool value = false;
  Flag() {}
  Flag(std::vector<bool>::reference bit) : value(bit) {}
};

int main() {
  std::vector<bool> bits{false, true, true};
  std::for_each(bits.begin(), bits.end(), toggle);
  std::for_each(bits.rbegin(), bits.rbegin() + 1, toggle);
  std::cout << bits[0] << bits[1] << bits[2] << '\n';

  int transformed[3], copied[3] = {0, 0, 0};
  std::transform(bits.begin(), bits.end(), transformed, bitToInt);
  std::copy_if(bits.begin(), bits.end(), copied, set);
  std::cout << transformed[0] << transformed[1] << transformed[2] << ' '
            << copied[0] << copied[1] << copied[2] << '\n';
  std::cout << std::count_if(bits.begin(), bits.end(), set) << ' '
            << std::accumulate(bits.begin(), bits.end(), 5, addBit) << ' '
            << std::equal(bits.begin(), bits.end(), bits.begin(), same) << '\n';
  Flag flags[3], filtered[3], mapped[3];
  std::copy(bits.begin(), bits.end(), flags);
  std::copy_if(bits.begin(), bits.end(), filtered, set);
  std::transform(bits.begin(), bits.end(), mapped, expose);
  for (int i = 0; i < 3; ++i) {
    if (i) std::cout << ' ';
    std::cout << flags[i].value << filtered[i].value << mapped[i].value;
  }
  std::cout << '\n';
  std::cout << (std::min_element(bits.begin(), bits.end(), less) - bits.begin()) << ' ';
  std::sort(bits.begin(), bits.end(), greaterBit);
  std::cout << std::next_permutation(bits.begin(), bits.end(), less) << ' '
            << (std::lower_bound(bits.begin(), bits.end(), true, lessValue) - bits.begin()) << '\n';

  int values[] = {1, 2};
  std::for_each(values, values + 2, increment);
  std::cout << values[0] << values[1] << '\n';
}
