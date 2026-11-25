#include <cstdio>
#include <cstdlib>
#include <memory>
struct Noisy {
  const char* name;
  ~Noisy() { std::printf("drop %s\n", name); }
};
Noisy first{"first"};
void late() { std::printf("late\n"); }
void early() { std::printf("early\n"); }
Noisy second{"second"};
int main() {
  std::atexit(early);
  static Noisy local{"local"};
  std::atexit(late);
  int x = 4;
  std::printf("%d\n", *std::addressof(x));
}
