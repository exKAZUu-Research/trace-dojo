#include <iostream>
#include <sstream>
#include <string>
#include <vector>
using namespace std;
int main() {
  ostringstream os; os << "x=" << 42 << ", y=" << 3.5; cout << os.str() << endl;
  istringstream is("10 20 30 abc"); int a, b, c; string w; is >> a >> b >> c >> w; cout << a + b + c << w << endl;
  stringstream ss("one two three"); string word; vector<string> words; while (ss >> word) words.push_back(word);
  cout << words.size() << words[2] << endl;
  istringstream lines("first line\nsecond line\nthird"); string line; int n = 0; while (getline(lines, line)) { n++; cout << n << ":" << line << endl; }
  istringstream csv("a,b,,c"); string field; while (getline(csv, field, ',')) cout << "[" << field << "]"; cout << endl;
  istringstream bad("12x"); int v; bad >> v; cout << v << " " << bad.fail() << endl; char ch; bad >> ch; cout << ch << endl;
  cerr << "to stderr" << endl;
  int k = 7; istringstream empty(""); if (!(empty >> k)) cout << "failed " << k << endl;
  ostringstream receiver;
  cout << (&receiver == &receiver.put('a')) << (&receiver == &receiver.write("bc", 2))
       << (&receiver == &receiver.flush()) << receiver.str() << '\n';
  istringstream bytes("\xc3\xa9");
  unsigned char unsignedByte;
  signed char signedByte;
  bytes >> unsignedByte >> signedByte;
  cout << int(unsignedByte) << ' ' << int(signedByte) << '\n';
}
