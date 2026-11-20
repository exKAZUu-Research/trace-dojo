#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>
using namespace std;
class MyError : public runtime_error {
 public:
  MyError(const string& m) : runtime_error("My: " + m) {}
};
struct Guard { string n; Guard(string n) : n(n) {} ~Guard() { cout << "~Guard " << n << endl; } };
int check(int x) {
  Guard g("check");
  if (x < 0) throw invalid_argument("negative");
  if (x == 0) throw MyError("zero");
  if (x > 100) throw 42;
  return x * 2;
}
int main() {
  for (int x : {5, -1, 0, 200}) {
    try {
      cout << check(x) << endl;
    } catch (const invalid_argument& e) {
      cout << "invalid: " << e.what() << endl;
    } catch (const exception& e) {
      cout << "exception: " << e.what() << endl;
    } catch (int n) {
      cout << "int " << n << endl;
    }
  }
  try {
    vector<int> v(3);
    v.at(5) = 1;
  } catch (const out_of_range& e) { cout << "oor " << e.what() << endl; }
  try {
    string s = "abc"; s.at(10);
  } catch (exception& e) { cout << e.what() << endl; }
  try { stoi("xyz"); } catch (const invalid_argument& e) { cout << e.what() << endl; }
  try { stoi("99999999999"); } catch (const out_of_range& e) { cout << e.what() << endl; }
  try {
    try { throw runtime_error("inner"); } catch (...) { cout << "rethrow" << endl; throw; }
  } catch (const runtime_error& e) { cout << "outer " << e.what() << endl; }
  Guard g("main");
  throw MyError("uncaught");
}
