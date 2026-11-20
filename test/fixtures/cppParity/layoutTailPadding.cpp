#include <iostream>
#include <string>
using namespace std;

// A derived class places its members in the tail padding of a base that is not POD (C++11 [class]p10).
struct Plain { int x; char c; };
struct AfterPlain : Plain { char d; };
struct Private { void f() {} private: int x; char c; };
struct AfterPrivate : Private { char d; };
struct MixedAccess { int x; protected: char c; };
struct AfterMixedAccess : MixedAccess { char d; };
struct Constructed { Constructed() {} int x; char c; };
struct AfterConstructed : Constructed { char d; };
struct Initialized { int x = 0; char c; };
struct AfterInitialized : Initialized { char d; };
struct Destructed { ~Destructed() {} int x; char c; };
struct AfterDestructed : Destructed { char d; };
struct WithReference { int& r; char c; };
struct AfterWithReference : WithReference { char d; };
struct WithString { string s; char c; };
struct AfterWithString : WithString { char d; };
struct WithPlain { Plain p; char c; };
struct AfterWithPlain : WithPlain { char d; };
struct Empty {};
struct OnEmpty : Empty { int x; char c; };
struct AfterOnEmpty : OnEmpty { char d; };

struct Base { virtual ~Base() {} int a; };
struct Wide : Base { int b; };
struct Narrow : Base { char c; };
struct Shape { virtual void draw() {} char c; };
struct Square : Shape { char d; int e; };
struct NonVirtual { int x; };
struct Virtual : NonVirtual { virtual void f() {} int y; };

int main() {
  cout << sizeof(AfterPlain) << " " << sizeof(AfterPrivate) << " " << sizeof(AfterMixedAccess) << endl;
  cout << sizeof(AfterConstructed) << " " << sizeof(AfterInitialized) << " " << sizeof(AfterDestructed) << endl;
  cout << sizeof(WithReference) << " " << sizeof(AfterWithReference) << " " << sizeof(AfterWithString) << endl;
  cout << sizeof(AfterWithPlain) << " " << sizeof(AfterOnEmpty) << endl;
  cout << sizeof(Base) << " " << sizeof(Wide) << " " << sizeof(Narrow) << endl;
  cout << sizeof(Shape) << " " << sizeof(Square) << " " << sizeof(Virtual) << endl;
}
