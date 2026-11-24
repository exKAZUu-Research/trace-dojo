#include <cstdio>

int main() {
  wchar_t w = L'A';
  char16_t c16 = u'あ';
  char32_t c32 = U'😀';
  char8_t c8 = u8'x';
  const wchar_t* ws = L"日本";
  const char16_t* s16 = u"a😀";
  const char32_t* s32 = U"xyz";
  const char8_t* s8 = u8"é";
  printf("%d %d %u %d\n", (int)w, (int)c16, (unsigned)c32, (int)c8);
  printf("%zu %zu %zu %zu %zu\n", sizeof(wchar_t), sizeof(char16_t), sizeof(char32_t), sizeof(char8_t), sizeof(L"ab"));
  printf("%d %d %d %d %d %d\n", (int)ws[0], (int)ws[1], (int)s16[1], (int)s16[2], (int)s32[2], (int)s8[1]);
  wchar_t buf[] = L"hey";
  printf("%zu %d\n", sizeof(buf) / sizeof(buf[0]), w == L'A');
}
