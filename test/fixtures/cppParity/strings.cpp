#include <iostream>
#include <string>
using namespace std;
int main() {
  string s = "Hello, World";
  cout << s.length() << " " << s.size() << " " << s.empty() << " " << s[0] << s.at(7) << endl;
  cout << s.substr(7) << "|" << s.substr(0, 5) << "|" << s.find("o") << " " << s.rfind("o") << " " << s.find("xyz") << endl;
  cout << (s.find("xyz") == string::npos) << " " << s.find('W') << " " << s.find_first_of("aeiou") << " " << s.find_last_not_of("dl") << endl;
  string t = s; t += "!"; t.append("?"); t.push_back('#');
  cout << t << " " << t.back() << t.front() << endl;
  t.insert(0, ">>"); t.erase(2, 7); t.replace(0, 2, "<<"); cout << t << endl;
  t.pop_back(); cout << t << endl;
  string a = "apple", b = "banana";
  cout << (a < b) << (a == "apple") << (a != b) << ("apple" == a) << a.compare(b) << b.compare(a) << a.compare("apple") << endl;
  string c = a + " & " + b + '!';
  cout << c << endl;
  for (char ch : a) cout << (char)toupper(ch);
  cout << endl;
  string num = to_string(42) + to_string(-7) + to_string(3.5);
  cout << num << " " << stoi("123") + 1 << " " << stod("2.5") * 2 << " " << stol("-99") << endl;
  string r(5, '*'); cout << r << endl;
  string j = "日本語"; cout << j << " " << j.size() << endl;
  s.clear(); cout << s.empty() << "[" << s << "]" << endl;
  string sp = "a b  c"; int spaces = 0; for (size_t i = 0; i < sp.size(); i++) if (sp[i] == ' ') spaces++;
  cout << spaces << endl;
  string w = "hello"; w[0] = 'J'; cout << w << " " << w.c_str() << endl;
  cout << w.starts_with("Je") << w.ends_with('o') << endl;
  string e; e.resize(3, 'x'); cout << e << endl;
}
