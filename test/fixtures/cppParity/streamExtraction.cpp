#include <iostream>
#include <sstream>
#include <string>
using namespace std;
int main() {
  const char* inputs[] = {"5abc", "0x10", "-12x", "+", "-", "- 1", "12 34", "99999999999", "-99999999999", "1e5", "  7", "", "   ", "0x", "077", "1.5", ".5", "abc", "-0"};
  for (const char* in : inputs) {
    { istringstream is(in); int i = -7; is >> i; bool f = is.fail(), e = is.eof(); is.clear(); string rest; getline(is, rest); cout << "int[" << in << "] " << i << f << e << " rest=[" << rest << "]\n"; }
    { istringstream is(in); unsigned u = 7; is >> u; cout << "uint " << u << is.fail() << is.eof() << '\n'; }
    { istringstream is(in); unsigned short u = 7; is >> u; cout << "ushort " << u << is.fail() << is.eof() << '\n'; }
    { istringstream is(in); long long l = 7; is >> l; cout << "llong " << l << is.fail() << is.eof() << '\n'; }
    { istringstream is(in); unsigned long long l = 7; is >> l; cout << "ullong " << l << is.fail() << is.eof() << '\n'; }
    { istringstream is(in); short sh = 7; is >> sh; cout << "short " << sh << is.fail() << is.eof() << '\n'; }
    { istringstream is(in); double d = -7; is >> d; bool f = is.fail(), e = is.eof(); is.clear(); string rest; getline(is, rest); cout << "double " << d << f << e << " rest=[" << rest << "]\n"; }
    { istringstream is(in); float fl = -7; is >> fl; cout << "float " << fl << is.fail() << is.eof() << '\n'; }
    { istringstream is(in); bool b = false; is >> b; cout << "bool " << b << is.fail() << is.eof() << '\n'; }
    { istringstream is(in); char c = 'q'; is >> c; cout << "char " << c << is.fail() << is.eof() << '\n'; }
    { istringstream is(in); string s = "old"; is >> s; cout << "string [" << s << "]" << is.fail() << is.eof() << '\n'; }
  }
  for (const char* in : {"1e999", "1e-400", "0x1p3", "1.2.3", "1e+5x", "0x1.8p1", "3.", "1e-310"}) {
    istringstream is(in); double d = -7; is >> d; cout << in << ' ' << d << is.fail() << is.eof() << '\n';
  }
  {
    istringstream is("ff 10 777"); int a = 0, b = 0, c = 0;
    is.setf(ios::hex, ios::basefield); is >> a;
    is.setf(ios::oct, ios::basefield); is >> b;
    is.unsetf(ios::basefield); is >> c;
    cout << a << ' ' << b << ' ' << c << '\n';
    istringstream js("0x1f 010 12"); js.unsetf(ios::basefield); js >> a >> b >> c; cout << a << ' ' << b << ' ' << c << '\n';
    istringstream ks("0x1f"); ks.setf(ios::hex, ios::basefield); ks >> a; cout << a << ks.fail() << '\n';
  }
  {
    istringstream is("true false tru x"); is.setf(ios::boolalpha); bool b = false;
    is >> b; cout << b << is.fail(); is >> b; cout << b << is.fail(); is >> b; cout << b << is.fail() << is.eof() << '\n';
  }
  {
    stringstream ss; ss << "42 x"; int a = 0; ss >> a; cout << a << '\n';
    string w; ss >> w; cout << w << ss.eof() << '\n';
    ss << "more"; cout << ss.str() << '\n';
    ss.clear(); ss << "!"; cout << ss.str() << '\n';
    stringstream s2("1 2"); s2 << "9"; cout << s2.str() << '\n';
    int x = 0, y = 0; s2 >> x >> y; cout << x << y << '\n';
    ostringstream os("abcdef"); os << "XY"; cout << os.str() << '\n';
    os.str("q"); os << "12"; cout << os.str() << '\n';
    istringstream is("a b"); string t; is >> t >> t >> t; cout << t << is.fail() << is.eof() << '\n';
    is.str("c d"); is >> t; cout << t << is.fail() << '\n';
    is.clear(); is >> t; cout << t << is.fail() << '\n';
  }
  {
    istringstream is("abcdef ghi"); is.width(3); string s; is >> s; cout << s << '|'; is >> s; cout << s << '|' << is.eof() << '\n';
    istringstream js("line1\nline2"); string l; getline(js, l); cout << l; getline(js, l); cout << l << js.eof() << js.fail(); l = "keep"; getline(js, l); cout << l << js.fail() << '\n';
    istringstream ns(" x"); ns.unsetf(ios::skipws); char c = 'q'; ns >> c; cout << '[' << c << ']'; int n = 5; ns >> n; cout << n << ns.fail() << '\n';
    istringstream es(""); es.unsetf(ios::skipws); int m = 5; es >> m; cout << m << es.fail() << es.eof() << '\n';
  }
}
