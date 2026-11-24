#include <cstdio>
int sum(int n) {
  int a[n];
  for (int i = 0; i < n; i++) a[i] = i * i;
  int s = 0;
  for (int i = 0; i < n; i++) s += a[i];
  return s + (int)sizeof(a);
}
int main() {
  int n = 5;
  double grid[n][3];
  grid[4][2] = 1.5;
  printf("%d %g %zu\n", sum(4), grid[4][2], sizeof(grid));
  int m = 3;
  int b[m];
  for (int& x : b) x = 7;
}
