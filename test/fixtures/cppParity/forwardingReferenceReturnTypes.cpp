#include <utility>
#include <cstdio>
struct S { int v = 3; auto&& get() && { return std::move(v); } auto& ref() { return v; } };
int main() { S s; int&& r = std::move(s).get(); auto&& f = std::move(s.v); printf("%d %d\n", r, f); }
