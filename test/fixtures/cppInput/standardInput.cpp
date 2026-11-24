#include <cstdio>
#include <iostream>
int main() {
  int a, b;
  double x;
  char name[16];
  int n = scanf("%d %d", &a, &b);
  scanf("%lf %15s", &x, name);
  int c = getchar();
  char line[32];
  fgets(line, sizeof line, stdin);
  printf("%d %d %d %.2f %s [%d] line=%s", n, a, b, x, name, c, line);
  int k;
  std::cin >> k;
  std::cout << "cin " << k << "\n";
  int t1, t2;
  int r = sscanf("12-34", "%d-%d", &t1, &t2);
  printf("%d %d %d\n", r, t1, t2);
  int ch;
  int count = 0;
  while ((ch = getchar()) != EOF) if (ch == 'z') count++;
  printf("z=%d %d\n", count, scanf("%d", &a));
}
