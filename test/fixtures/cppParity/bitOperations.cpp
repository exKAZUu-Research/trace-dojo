#include <bit>
#include <bitset>
#include <cstdint>
#include <iostream>
int main() {
  unsigned x = 0b1011'0000u;
  std::cout << std::popcount(x) << std::has_single_bit(64u) << std::has_single_bit(65u) << "\n";
  std::cout << std::bit_ceil(17u) << " " << std::bit_floor(17u) << " " << std::bit_width(17u) << "\n";
  std::cout << std::countl_zero(x) << " " << std::countr_zero(x) << " " << std::countl_one(0xF0000000u) << " " << std::countr_one(7u) << "\n";
  std::uint8_t b = 0b1001'0110;
  std::cout << +std::rotl(b, 1) << " " << +std::rotr(b, 3) << " " << +std::rotl(b, -2) << "\n";
  std::cout << std::countl_zero(std::uint64_t{1}) << " " << std::popcount(~std::uint64_t{0}) << "\n";
  std::cout << (std::endian::native == std::endian::little) << "\n";
  float f = 1.0f;
  auto bits = std::bit_cast<std::uint32_t>(f);
  std::cout << std::hex << bits << std::dec << "\n";
  std::cout << std::bit_cast<double>(std::uint64_t{0x4000000000000000}) << "\n";
  std::cout << std::bitset<32>(std::bit_cast<std::uint32_t>(-0.5f)) << "\n";
}
