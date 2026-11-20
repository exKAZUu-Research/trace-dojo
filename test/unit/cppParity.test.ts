import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

const FIXTURE_DIR = path.join(import.meta.dirname, '..', 'fixtures', 'cppParity');

// The interpreter's clock stands still in these tests, so that the program, not the load of the host, decides each one.
beforeEach(() => {
  vi.spyOn(performance, 'now').mockReturnValue(0);
});
afterEach(() => {
  vi.restoreAllMocks();
});

test.each([
  ['iostream', 'int a[] = {1, 2}, b[2]; std::partial_sum(a, a + 2, b); std::cout << b[1];', '3'],
  ['iterator', 'int a[] = {3, 7, 9}; std::printf("%d", *std::find(a, a + 3, 7));', '7'],
  ['cstdio', 'std::FILE* stream = stdout; std::fputs("ready", stream);', 'ready'],
])('uses declarations exposed by the Apple SDK through <%s>', (header, body, stdout) => {
  const program = `#include <${header}>
int main() { ${body} }`;
  expect(executeProgram('cpp', program)).toMatchObject({ kind: 'executed', stdout, uncaughtException: undefined });
});

test('selects the algorithm remove overload when its declaration is visible', () => {
  const program = `#include <algorithm>
#include <cstdio>
using namespace std;
int main() {
  int a[] = {1, 2, 1};
  std::printf("%ld", remove(a, a + 3, 1) - a);
}`;
  expect(executeProgram('cpp', program)).toMatchObject({ kind: 'executed', stdout: '1', uncaughtException: undefined });
});

test('uses the full type after a defining header follows an SDK forward declaration', () => {
  const program = `#include <iosfwd>
std::string* seen;
const std::stringstream& forward(const std::stringstream& input) { return input; }
#include <sstream>
#include <string>
#include <iostream>
int main() {
  std::string value{"abc"};
  seen = &value;
  std::stringstream stream{"def"};
  std::cout << seen->size() << forward(stream).str();
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '3def',
    uncaughtException: undefined,
  });
});

test('uses the Apple libc++ layouts of each supported stream class and its bases', () => {
  const program = `#include <iostream>
#include <sstream>
int main() {
  std::cout << sizeof(std::ios_base) << ' ' << sizeof(std::ios) << ' ' << sizeof(std::ostream) << ' '
            << sizeof(std::istream) << ' ' << sizeof(std::ostringstream) << ' ' << sizeof(std::istringstream)
            << ' ' << sizeof(std::stringstream) << ' ';
  std::ostringstream output;
  std::ios& status = output;
  std::ios_base& format = status;
  format.setf(std::ios::hex, std::ios_base::basefield);
  std::showbase(format);
  output << 42;
  if (status) std::cout << output.str();
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '136 152 160 168 264 272 280 0x2a',
    uncaughtException: undefined,
  });
});

test('selects SDK signbit templates for floating and integer arguments', () => {
  const program = `#include <cmath>
#include <iostream>
int main() {
  std::cout << std::signbit(-0.0f) << std::signbit(-0.0) << std::signbit(-0.0L)
            << std::signbit(-1L) << std::signbit(0.0);
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '11110',
    uncaughtException: undefined,
  });
});

test('preserves negative NaNs across C++ width conversions, sign operations, and byte views', () => {
  const program = `#include <cmath>
#include <iostream>
int main() {
  double value = -NAN;
  float narrow = static_cast<float>(value);
  long double wide = std::copysign(0.0L, narrow);
  std::cout << std::signbit(value) << std::signbit(narrow) << std::signbit(wide) << ' '
            << std::copysign(1.0, value) << ' ' << std::signbit(std::copysign(NAN, value)) << ' '
            << std::isnan(value) << (value == value) << std::signbit(-value) << ' ';
  unsigned char* bytes = static_cast<unsigned char*>(static_cast<void*>(&value));
  auto high = sizeof(value) - 1;
  std::cout << unsigned(bytes[high] >> 7);
  bytes[high] &= 127;
  std::cout << std::signbit(value) << std::isnan(value);
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '111 -1 1 100 101',
    uncaughtException: undefined,
  });
});

test('matches Apple libm NaN signs across unary, mixed-width, and fused operations', () => {
  const program = `#include <cmath>
#include <iostream>
int main() {
  double negative = -NAN;
  float single = -NAN;
  long double extended = -NAN;
  double positive = NAN;
  std::cout << std::signbit(std::sqrt(negative)) << std::signbit(std::sin(single))
            << std::signbit(std::fma(extended, 1.0L, 1.0L)) << ' '
            << std::signbit(std::atan2(positive, single)) << std::signbit(std::atan2(negative, positive))
            << std::signbit(std::pow(negative, positive)) << ' '
            << std::signbit(std::fabs(negative)) << std::isnan(std::pow(negative, 0))
            << std::fmin(negative, 2.0);
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '111 010 002',
    uncaughtException: undefined,
  });
});

test('retains floating object bytes written through unsigned char views', () => {
  const program = `#include <cmath>
#include <iostream>
int main() {
  unsigned char source[8] = {0x42, 0, 0, 0, 0, 0, 0xf8, 0x7f};
  double value;
  auto bytes = static_cast<unsigned char*>(static_cast<void*>(&value));
  for (int i = 0; i < 8; ++i) bytes[i] = source[i];
  std::cout << int(bytes[0]) << ' ' << int(bytes[6]) << ' ' << std::isnan(value) << std::signbit(value) << ' ';
  double copy = std::copysign(value, -1.0);
  auto copied = static_cast<unsigned char*>(static_cast<void*>(&copy));
  std::cout << int(copied[0]) << ' ' << int(copied[7]) << ' ' << std::signbit(copy) << ' ';
  float narrow;
  auto single = static_cast<unsigned char*>(static_cast<void*>(&narrow));
  single[0] = 0x51;
  single[1] = 0;
  single[2] = 0xc0;
  single[3] = 0xff;
  std::cout << int(single[0]) << ' ' << std::signbit(narrow);
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '66 248 10 66 255 1 81 1',
    uncaughtException: undefined,
  });
});

test('preserves the selected NaN payload through unary and binary libm calls', () => {
  const program = `#include <cmath>
#include <iostream>
unsigned char* bytes(double& value) {
  return static_cast<unsigned char*>(static_cast<void*>(&value));
}
int main() {
  unsigned char first[8] = {0x42, 0, 0, 0, 0, 0, 0xf8, 0x7f};
  double positive;
  for (int i = 0; i < 8; ++i) bytes(positive)[i] = first[i];
  double negative = positive;
  bytes(negative)[0] = 0x53;
  bytes(negative)[7] = 0xff;
  double root = std::sqrt(positive);
  double sine = std::sin(negative);
  double power = std::pow(positive, negative);
  double angle = std::atan2(positive, negative);
  double magnitude = std::fabs(negative);
  std::cout << int(bytes(root)[0]) << ' ' << int(bytes(sine)[0]) << ' '
            << int(bytes(power)[0]) << ' ' << int(bytes(angle)[0]) << ' '
            << int(bytes(magnitude)[0]) << ' ' << std::signbit(magnitude);
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '66 83 83 66 83 0',
    uncaughtException: undefined,
  });
});

test('quiets signaling NaNs during floating arithmetic and retains the chosen payload', () => {
  const program = `#include <cmath>
#include <functional>
#include <iostream>
void show(double& value) {
  auto bytes = static_cast<unsigned char*>(static_cast<void*>(&value));
  std::cout << int(bytes[0]) << ':' << int(bytes[6]) << ':' << int(bytes[7]) << ' ';
}
int main() {
  unsigned char source[8] = {0x42, 0, 0, 0, 0, 0, 0xf0, 0xff};
  double value;
  auto bytes = static_cast<unsigned char*>(static_cast<void*>(&value));
  for (int i = 0; i < 8; ++i) bytes[i] = source[i];
  double added = NAN + value;
  double product = std::multiplies<double>()(value, 1.0);
  double fused = std::fma(1.0, value, NAN);
  double contracted = value * 2.0 + 1.0;
  show(value);
  show(added);
  show(product);
  show(fused);
  show(contracted);
  std::cout << std::isnan(std::fmin(value, 1.0)) << std::isnan(std::fmin(1.0, value))
            << std::isnan(std::fmax(value, 1.0)) << std::isnan(std::fmax(1.0, value)) << ' '
            << std::fmax(added, 4.0) << ' ' << std::fmin(1.0, added);
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '66:240:255 66:248:255 66:248:255 66:248:255 66:248:255 1111 4 1',
    uncaughtException: undefined,
  });
});

test('retains the Apple libc++ signaling NaN from numeric_limits at each width', () => {
  const program = `#include <iostream>
#include <limits>
int main() {
  constexpr double constant = std::numeric_limits<double>::signaling_NaN();
  double wide = constant;
  float single = std::numeric_limits<float>::signaling_NaN();
  long double extended = std::numeric_limits<long double>::signaling_NaN();
  auto d = static_cast<unsigned char*>(static_cast<void*>(&wide));
  auto f = static_cast<unsigned char*>(static_cast<void*>(&single));
  auto l = static_cast<unsigned char*>(static_cast<void*>(&extended));
  double computed = wide + 1.0;
  auto result = static_cast<unsigned char*>(static_cast<void*>(&computed));
  std::cout << int(d[6]) << ' ' << int(d[7]) << ' ' << int(f[2]) << ' ' << int(f[3]) << ' '
            << int(l[6]) << ' ' << int(l[7]) << ' ' << int(result[6]);
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '244 127 160 127 244 127 252',
    uncaughtException: undefined,
  });
});

test.each(['float', 'double', 'long double'])(
  'uses the Apple invalid-product result for fused %s expressions',
  (type) => {
    const program = `#include <cmath>
#include <iostream>
#include <limits>
void check(${type} zero, ${type} infinity, ${type} quiet, ${type} signaling) {
  std::cout << std::signbit(std::fma(zero, infinity, quiet))
            << std::signbit(std::fma(infinity, zero, quiet))
            << std::signbit(zero * infinity + quiet)
            << std::signbit(std::fma(zero, infinity, signaling))
            << std::signbit(zero * infinity + signaling)
            << std::signbit(std::fma(zero, static_cast<${type}>(3), quiet));
}
int main() {
  check(0, std::numeric_limits<${type}>::infinity(), -std::numeric_limits<${type}>::quiet_NaN(),
        -std::numeric_limits<${type}>::signaling_NaN());
}`;
    expect(executeProgram('cpp', program)).toMatchObject({
      kind: 'executed',
      stdout: '000111',
      uncaughtException: undefined,
    });
  }
);

test('keeps the ordered container size visible to mapped destructors', () => {
  const program = `#include <iostream>
#include <map>
struct Item;
std::map<int, Item>* active;
struct Item {
  int key;
  Item(int value) : key(value) {}
  ~Item() { std::cout << key << ':' << active->size() << ' '; }
};
int main() {
  std::map<int, Item> values;
  active = &values;
  values.try_emplace(2, 2);
  values.try_emplace(1, 1);
  values.clear();
  std::cout << values.size() << ' ';
  values.try_emplace(4, 4);
  values.try_emplace(3, 3);
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '1:2 2:2 0 3:2 4:2 ',
    uncaughtException: undefined,
  });
});

test('reads the signed representation of constant NaNs from storage', () => {
  const program = `#include <cmath>
#include <iostream>
const double global = -NAN;
struct Constants { static constexpr double value = -NAN; };
int main() {
  const double local = -NAN;
  constexpr double value = -NAN;
  constexpr double copy = value;
  const double& bound = local;
  std::cout << std::signbit(global) << std::signbit(local) << std::signbit(value)
            << std::signbit(copy) << std::signbit(Constants::value) << std::signbit(bound);
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '111111',
    uncaughtException: undefined,
  });
});

test('shares signed NaN arithmetic with numeric algorithms and typed function objects', () => {
  const program = `#include <algorithm>
#include <cmath>
#include <functional>
#include <iostream>
#include <numeric>
int main() {
  double start = -NAN;
  float values[2];
  std::iota(values, values + 2, start);
  std::cout << std::signbit(values[0]) << std::signbit(values[1])
            << std::signbit(std::plus<double>()(start, 1.0))
            << std::signbit(std::multiplies<float>()(values[0], 2.0f))
            << (std::find(values, values + 2, start) == values + 2);
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '11111',
    uncaughtException: undefined,
  });
});

test('preserves signed NaN prefixes in all C++ string conversions', () => {
  const program = `#include <cmath>
#include <iostream>
#include <string>
int main() {
  std::size_t used = 0;
  double value = std::stod(" -nan.tail", &used);
  float single = std::stof("-nan(payload)");
  long double extended = std::stold("-NaN");
  std::cout << std::signbit(value) << std::signbit(single) << std::signbit(extended)
            << std::signbit(std::stod("+nan")) << ' ' << std::copysign(1.0, value) << ' ' << used;
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '1110 -1 5',
    uncaughtException: undefined,
  });
});

test('lays out fixed arrays and enclosing pairs after a forward-declared element is complete', () => {
  const program = `#include <array>
#include <iostream>
#include <utility>
struct Item;
std::array<Item, 2>* pointer;
std::pair<std::array<Item, 2>, char>* pair;
std::pair<std::array<Item, 0>, char>* empty;
struct Item { long value; };
struct Layout { char tag; std::pair<std::array<Item, 2>, char> values; };
int main() { std::cout << sizeof(*pointer) << ' ' << sizeof(*pair) << ' ' << sizeof(*empty) << ' ' << sizeof(Layout); }`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '16 24 16 32',
    uncaughtException: undefined,
  });
});

test.each([
  'std::copy(a, a + 3, a + 1);',
  'std::copy(a, a + 3, a);',
  'std::copy_if(a + 1, a + 4, a, selected);',
  'std::copy_if(a, a + 3, a + 1, selected);',
  'std::copy(b.rbegin(), b.rbegin() + 3, b.rbegin() + 1);',
  'std::copy(b.begin(), b.end(), b.rbegin());',
  'std::copy(c.begin(), c.end(), std::next(c.begin()));',
  'std::copy(c.begin(), std::next(c.begin()), &c.front());',
  'std::copy(d.begin() + 1023, d.end(), d.begin() + 1024);',
])('diagnoses overlap in %s', (body) => {
  const program = `#include <algorithm>
#include <deque>
#include <iterator>
#include <list>
#include <vector>
bool selected(int value) { return value == 3; }
int main() {
  int a[] = {1, 2, 3, 4};
  std::vector<int> b{1, 2, 3, 4};
  std::list<int> c{1, 2, 3, 4};
  std::deque<int> d(2050, 1);
  ${body}
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: 'コピー元とコピー先の領域が重なっています。',
  });
});

test.each([
  ['vector', 'values.insert(values.end(), values.begin(), values.end());'],
  ['vector', 'values.assign(values.data(), values.data() + values.size());'],
  ['deque', 'values.insert(values.end(), values.rbegin(), values.rend());'],
  ['deque', 'values.assign(values.cbegin(), values.cend());'],
  ['list', 'values.insert(values.end(), values.cbegin(), values.cbegin());'],
  ['list', 'values.assign(values.rbegin(), values.rend());'],
  ['list', 'values.assign(&values.front(), &values.front() + 1);'],
  ['list', 'values.assign(2, values.front());'],
])('rejects a reference or range into the destination %s in %s', (container, body) => {
  const program = `#include <${container}>
int main() {
  std::${container}<int> values{1, 2, 3};
  ${body}
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: 'コピー元とコピー先の領域が重なっています。',
  });
});

test('inserts and assigns ranges from other sequence containers', () => {
  const program = `#include <deque>
#include <iostream>
#include <list>
#include <vector>
int main() {
  std::list<int> source{1, 2};
  std::vector<int> target{3};
  target.insert(target.begin(), source.rbegin(), source.rend());
  std::deque<int> result;
  result.assign(target.data(), target.data() + target.size());
  for (int value : result) std::cout << value;
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '213',
    uncaughtException: undefined,
  });
});

test('allows std::copy toward the beginning of the same array', () => {
  const program = `#include <algorithm>
#include <iostream>
int main() {
  int values[] = {1, 2, 3, 4};
  std::copy(values + 1, values + 4, values);
  for (int value : values) std::cout << value;
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '2344',
    uncaughtException: undefined,
  });
});

test.each(['std::advance(it, -1);', 'it = std::next(it, -1);'])(
  'rejects negative forward iterator steps in %s',
  (body) => {
    const program = `#include <iterator>
#include <unordered_set>
int main() {
  std::unordered_set<int> values{1, 2};
  auto it = std::next(values.begin());
  ${body}
}`;
    expect(executeProgram('cpp', program)).toMatchObject({
      kind: 'executed',
      uncaughtException: expect.stringContaining('使えなくなったイテレータ'),
    });
  }
);

test.each([
  ['list', 'auto saved = values.begin(); values.erase(saved);', 'saved == values.begin()'],
  ['list', 'auto saved = values.begin(); values.erase(saved);', 'values.end() != saved'],
  ['list', 'auto saved = values.begin(); values.erase(saved);', 'saved == other.end()'],
  ['unordered_set', 'auto saved = values.begin(); values.erase(saved);', 'saved != values.end()'],
  ['deque', 'auto saved = values.end(); values.push_back(3);', 'saved == other.end()'],
])('diagnoses invalidated %s iterators before comparing them', (container, mutation, comparison) => {
  const program = `#include <${container}>
int main() {
  std::${container}<int> values{1, 2}, other{3};
  ${mutation}
  return ${comparison};
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: expect.stringContaining('使えなくなったイテレータ'),
  });
});

test('allows negative movement of bidirectional iterators', () => {
  const program = `#include <iostream>
#include <iterator>
#include <list>
int main() {
  std::list<int> values{1, 2, 3};
  auto it = std::next(values.end(), -1);
  std::advance(it, -1);
  std::cout << *it;
}`;
  expect(executeProgram('cpp', program)).toMatchObject({ kind: 'executed', stdout: '2', uncaughtException: undefined });
});

test('shares ordered container and iterator types with an explicitly spelled default comparator', () => {
  const program = `#include <functional>
#include <iostream>
#include <map>
#include <set>
void inspect(const std::map<int, int>& values, std::map<int, int>::const_iterator first) {
  std::cout << values.size() << first->second;
}
int main() {
  std::map<int, int, std::less<int>> map{{1, 2}};
  std::multimap<int, int, std::less<int>> multiMap{{1, 3}};
  std::set<int, std::less<int>> set{4};
  std::multiset<int, std::less<int>> multiSet{5, 5};
  const std::multimap<int, int>& a = multiMap;
  const std::set<int>& b = set;
  const std::multiset<int>& c = multiSet;
  std::less<void> transparent;
  const std::less<>& compare = transparent;
  inspect(map, map.cbegin());
  std::cout << a.begin()->second << *b.begin() << c.size() << compare(1, 2) << std::plus<void>()(2, 3);
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '1234215',
    uncaughtException: undefined,
  });
});

test('shares libc++ iterator types across compatible container specializations', () => {
  const program = `#include <array>
#include <functional>
#include <iostream>
#include <iterator>
#include <map>
#include <set>
#include <string>
#include <vector>
int main() {
  std::array<int, 3> values{3, 4, 5};
  int plain[] = {6, 7};
  std::array<int, 2>::reverse_iterator array = values.rbegin();
  std::cout << *array;
  array = std::rbegin(plain);
  std::multimap<int, int, std::greater<int>> map{{1, 2}};
  std::map<int, int>::iterator mapped = map.begin();
  std::multiset<int, std::greater<int>> set{8};
  std::set<int>::iterator key = set.begin();
  std::vector<char> letters{'x'};
  std::string::iterator letter = letters.begin();
  std::cout << *array << mapped->second << *key << *letter;
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '5728x',
    uncaughtException: undefined,
  });
});

test('checks container ownership even for a shared iterator type', () => {
  const program = `#include <map>
int main() {
  std::map<int, int> target{{1, 2}};
  std::multimap<int, int> source{{1, 3}};
  target.erase(source.begin());
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: expect.stringContaining('使えなくなったイテレータ'),
  });
});

test('uses the libc++ iterator aliases for immutable set keys', () => {
  const program = `#include <iostream>
#include <set>
#include <unordered_set>
int main() {
  std::set<int> set{1, 2};
  std::multiset<int> multi{3, 4};
  std::unordered_set<int> unordered{5};
  const std::set<int>& readSet = set;
  const std::multiset<int>& readMulti = multi;
  std::set<int>::iterator a = set.cbegin();
  std::set<int>::reverse_iterator b = readSet.rbegin();
  std::multiset<int>::iterator c = multi.cbegin();
  std::multiset<int>::reverse_iterator d = readMulti.rbegin();
  std::unordered_set<int>::iterator e = unordered.cbegin();
  std::cout << *a << *b << *c << *d << *e;
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '12345',
    uncaughtException: undefined,
  });
});

test('reuses already constructed mapped values during ordered-map assignment', () => {
  const program = `#include <iostream>
#include <map>
int copies = 0;
struct Value {
  int number;
  Value(int n) : number(n) {}
  Value(const Value& source) : number(source.number) { ++copies; }
};
int main() {
  std::map<int, Value> target{{1, 1}, {2, 2}}, source{{3, 3}, {4, 4}};
  copies = 0;
  target = source;
  std::cout << copies << ' ' << target.begin()->first << ' ' << target.size();
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '0 3 2',
    uncaughtException: undefined,
  });
});

test('retains reused ordered-map nodes when construction of a new subtree throws', () => {
  const program = `#include <iostream>
#include <map>
bool armed = false;
struct Value {
  int number;
  Value(int n) : number(n) {}
  Value(const Value& source) : number(source.number) { if (armed && number == 4) throw 4; }
};
int main() {
  std::map<int, Value> target{{1, 1}}, source{{3, 3}, {4, 4}};
  armed = true;
  try { target = source; } catch (int error) { std::cout << error << ' '; }
  std::cout << target.size() << ' ' << target.begin()->first << ':' << target.begin()->second.number;
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '4 1 3:3',
    uncaughtException: undefined,
  });
});

test('keeps the previous ordered-map size and begin when a later subtree copy throws', () => {
  const program = `#include <iostream>
#include <map>
bool armed = false;
struct Value {
  int number;
  Value(int n) : number(n) {}
  Value(const Value& source) : number(source.number) { if (armed && number == 3) throw 3; }
};
int main() {
  std::map<int, Value> target{{9, 9}}, source{{2, 2}, {1, 1}, {3, 3}};
  armed = true;
  try { target = source; } catch (int error) { std::cout << error << ' '; }
  std::cout << target.size() << ' ' << target.begin()->first << ' ' << target.count(1) << ' ';
  armed = false;
  target = source;
  std::cout << target.size() << ' ' << target.begin()->first;
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '3 1 2 1 3 1',
    uncaughtException: undefined,
  });
});

test.each(['map', 'multimap'])('keeps the cached std::%s size unsigned after an interrupted copy', (kind) => {
  const program = `#include <iostream>
#include <map>
bool armed = false;
struct Value {
  int number;
  Value(int n) : number(n) {}
  Value(const Value& source) : number(source.number) { if (armed && number == 3) throw 3; }
};
int main() {
  std::${kind}<int, Value> target{{9, 9}}, source{{2, 2}, {1, 1}, {3, 3}};
  armed = true;
  try { target = source; } catch (int) {}
  std::cout << target.erase(1) << target.erase(2) << ' ' << target.size() << ' ' << target.empty();
  target.emplace(5, 5);
  auto copied = target;
  std::cout << ' ' << target.size() << (copied.begin() == copied.end());
  target.clear();
  std::cout << ' ' << target.size();
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '11 18446744073709551615 0 01 0',
    uncaughtException: undefined,
  });
});

test.each([
  ['find_if', 'true'],
  ['find_if_not', 'false'],
])('returns an early %s match when only the end iterator is invalidated', (algorithm, accepted) => {
  const program = `#include <algorithm>
#include <iostream>
#include <vector>
std::vector<int> values;
bool matches(int x) {
  values.push_back(9);
  return x == 1 ? ${accepted} : !${accepted};
}
int main() {
  values.reserve(5);
  values.push_back(1);
  auto found = std::${algorithm}(values.begin(), values.end(), matches);
  std::cout << *found << ' ' << values.size();
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '1 2',
    uncaughtException: undefined,
  });
});

test('uses consistent printed addresses, byte offsets and pointer order', () => {
  const program = `#include <cstdio>
#include <functional>
#include <iostream>
struct Pair { int first, second; };
int main() {
  int a[512]{};
  int b = 0;
  auto bytes = static_cast<unsigned char*>(static_cast<void*>(&b));
  Pair pair{};
  int* heap = new int;
  std::printf("%p %p %p %p %p %p ", (void*)&a[32], (void*)&a[33], (void*)&b, (void*)(&b + 1),
              (void*)(bytes + 1), (void*)&pair.first);
  std::cout << (void*)&a[32] << ' ' << (void*)&pair.second << ' '
            << (&a[32] == &b) << ((&a[32] < &b) == std::less<int*>()(&a[32], &b))
            << (&pair.first < &pair.second) << ((heap < &b) != (heap >= &b));
  delete heap;
}`;
  const result = executeProgram('cpp', program);
  expect(result).toMatchObject({ kind: 'executed', uncaughtException: undefined });
  if (result.kind !== 'executed') return;
  const [item, nextItem, scalar, scalarEnd, nextByte, firstField, streamedItem, secondField, comparisons] =
    result.stdout.split(' ');
  expect(item).toBe(streamedItem);
  expect(item).not.toBe(scalar);
  expect(BigInt(nextItem) - BigInt(item)).toBe(4n);
  expect(BigInt(scalarEnd) - BigInt(scalar)).toBe(4n);
  expect(BigInt(nextByte) - BigInt(scalar)).toBe(1n);
  expect(BigInt(secondField) - BigInt(firstField)).toBe(4n);
  expect(comparisons).toBe('0111');
});

test('projects library stream bases onto distinct physical locations and shares the virtual ios', () => {
  const program = `#include <iostream>
#include <sstream>
int main() {
  std::ostringstream output;
  std::istringstream input;
  std::stringstream both;
  std::ios* a = &output;
  std::ios* b = &input;
  std::ios* c = &both;
  std::istream* in = &both;
  std::ostream* out = &both;
  std::ios* fromIn = in;
  std::ios* fromOut = out;
  std::ios_base* asBase = fromOut;
  std::cout << (static_cast<void*>(a) == static_cast<void*>(&output))
            << (static_cast<void*>(b) == static_cast<void*>(&input))
            << (static_cast<void*>(c) == static_cast<void*>(&both))
            << (static_cast<void*>(in) == static_cast<void*>(out))
            << (fromIn == fromOut)
            << (static_cast<void*>(asBase) == static_cast<void*>(c)) << ' ';
  *out << 41;
  int value = 0;
  *in >> value;
  std::cout << value;
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '000011 41',
    uncaughtException: undefined,
  });
});

test('returns the appropriate stream view from formatted operations and manipulators', () => {
  const program = `#include <iomanip>
#include <iostream>
#include <sstream>
int main() {
  std::stringstream stream;
  std::ostream* output = &stream;
  std::istream* input = &stream;
  std::ostream& formatted = stream << 7;
  std::ostream& hex = stream << std::hex;
  std::ostream& padded = stream << std::setw(3);
  std::ostream& standard = std::cout << std::hex;
  int number = 0;
  std::istream& read = stream >> number;
  std::istream& inputHex = stream >> std::hex;
  std::cout << (static_cast<void*>(&formatted) == static_cast<void*>(output))
            << (static_cast<void*>(&hex) == static_cast<void*>(output))
            << (static_cast<void*>(&padded) == static_cast<void*>(output))
            << (static_cast<void*>(&standard) == static_cast<void*>(&std::cout))
            << (&read == input) << (&inputHex == input) << ' '
            << (std::ostringstream() << std::hex << 31).str();
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '111111 1f',
    uncaughtException: undefined,
  });
});

test('uses a static constant named through an object as a constant expression', () => {
  const program = `#include <iostream>
struct S { static const int N = 3; };
int main() {
  S s;
  S objects[2];
  int a[s.N];
  int b[objects[1].N];
  constexpr int k = s.N;
  switch (3) {
    case s.N: std::cout << sizeof(a) << ' ' << sizeof(b) << ' ' << k;
  }
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '12 12 3',
    uncaughtException: undefined,
  });
});

test('treats FILE prototypes as redeclarations of the C library functions', () => {
  const program = `#include <cstdio>
int fputs(const char*, FILE*);
int fflush(FILE*);
int main() {
  fputs("hello", stdout);
  fflush(stdout);
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: 'hello',
    uncaughtException: undefined,
  });
});

test('folds floating division by zero outside constant expressions', () => {
  const program = `#include <iostream>
#include <limits>
int main() {
  constexpr double overflow = 1e308 * 1e308;
  constexpr double nan = std::numeric_limits<double>::quiet_NaN();
  constexpr bool unordered = nan < 1.0;
  const double infinite = 1.0 / 0.0;
  static const double negative = -1.0 / 0.0;
  double runtime = 1.0 / 0.0;
  std::cout << overflow << ' ' << infinite << ' ' << negative << ' ' << runtime << ' ' << nan << unordered;
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: 'inf inf -inf inf nan0',
    uncaughtException: undefined,
  });
});

test('extracts integers in one pass as libc++ does, detecting the base from the prefix', () => {
  const program = `#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>
void checkInt(const char* text, int mode) {
  std::istringstream s(text);
  int n = 7;
  if (mode == 0) s >> std::setbase(0);
  if (mode == 16) s >> std::hex;
  if (mode == 8) s >> std::oct;
  s >> n;
  std::cout << +n << ',' << s.fail() << s.eof() << ',';
  s.clear();
  char c = '?';
  s >> c;
  std::cout << c << ' ';
}
void checkUnsigned(const char* text, int mode) {
  std::istringstream s(text);
  unsigned n = 7;
  if (mode == 0) s >> std::setbase(0);
  if (mode == 16) s >> std::hex;
  if (mode == 8) s >> std::oct;
  s >> n;
  std::cout << +n << ',' << s.fail() << s.eof() << ',';
  s.clear();
  char c = '?';
  s >> c;
  std::cout << c << ' ';
}
void checkLong(const char* text, int mode) {
  std::istringstream s(text);
  long n = 7;
  if (mode == 0) s >> std::setbase(0);
  if (mode == 16) s >> std::hex;
  if (mode == 8) s >> std::oct;
  s >> n;
  std::cout << +n << ',' << s.fail() << s.eof() << ',';
  s.clear();
  char c = '?';
  s >> c;
  std::cout << c << ' ';
}
int main() {
  const char* inputs[] = {"019x", "12abc", "0x1fz", "0", "0x", "-0x10", "+7", "-", "", "  42", "99999999999", "-2147483648", "-2147483649", "0X1A", "017", "x", "1e5"};
  for (int mode : {10, 0, 16, 8}) {
    for (const char* in : inputs) checkInt(in, mode);
    std::cout << '\\n';
  }
  for (const char* in : {"-1", "4294967296", "-4294967295", "18446744073709551616"}) checkUnsigned(in, 10);
  std::cout << '\\n';
  for (const char* in : {"9223372036854775808", "-9223372036854775808", "0x7fffffffffffffff"}) checkLong(in, 0);
  std::cout << '\\n';
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout:
      '19,00,x 12,00,a 0,00,x 0,01,? 0,00,x 0,00,x 7,01,? 0,11,? 7,11,? 42,01,? 2147483647,11,? -2147483648,01,? -2147483648,11,? 0,00,X 17,01,? 0,10,x 1,00,e \n1,00,9 12,00,a 31,00,z 0,01,? 0,11,? -16,01,? 7,01,? 0,11,? 7,11,? 42,01,? 2147483647,11,? -2147483648,01,? -2147483648,11,? 26,01,? 15,01,? 0,10,x 1,00,e \n25,00,x 76476,01,? 31,00,z 0,01,? 0,11,? -16,01,? 7,01,? 0,11,? 7,11,? 66,01,? 2147483647,11,? -2147483648,11,? -2147483648,11,? 26,01,? 23,01,? 0,10,x 485,01,? \n1,00,9 10,00,a 0,00,x 0,01,? 0,00,x 0,00,x 7,01,? 0,11,? 7,11,? 34,01,? 0,10,9 -9020,00,8 -9020,00,8 0,00,X 15,01,? 0,10,x 1,00,e \n4294967295,01,? 4294967295,11,? 1,01,? 4294967295,11,? \n9223372036854775807,11,? -9223372036854775808,01,? 9223372036854775807,01,? \n',
    uncaughtException: undefined,
  });
});

test('composes constant sizes of fixed arrays', () => {
  const program = `#include <array>
#include <iostream>
#include <iterator>
int main() {
  int a[3]{};
  constexpr auto n = std::size(a);
  int b[n]{};
  std::array<int, 4> c{};
  constexpr auto m = c.size();
  int d[m]{};
  constexpr auto j = std::size(c);
  int e[j]{};
  static int s[5];
  constexpr auto k = std::size(s);
  std::cout << n << m << k << ' ' << sizeof(b) << ' ' << sizeof(d) << sizeof(e);
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '345 12 1616',
    uncaughtException: undefined,
  });
});

test('sorts a list with a comparator in libc++ comparison order', () => {
  const program = `#include <functional>
#include <iostream>
#include <list>
int calls = 0;
bool by(int a, int b) { if (++calls < 40) std::cout << a << '<' << b << ' '; return a % 5 < b % 5; }
int left = 6;
bool thrower(int a, int b) { if (--left == 0) throw 1; return a < b; }
int main() {
  std::list<int> a;
  for (int i = 0; i < 20; ++i) a.push_back((i * 7) % 20);
  auto first = a.begin();
  int& anchor = *first;
  a.sort(by);
  std::cout << '\\n' << calls << ' ' << anchor << ' ';
  for (int v : a) std::cout << v << ',';
  std::list<int> b{5, 3, 9, 1, 7, 2, 8};
  try { b.sort(thrower); } catch (int) {}
  std::cout << '\\n';
  for (int v : b) std::cout << v << ',';
  std::list<int> c{3, 1, 2};
  c.sort(std::greater<int>());
  for (int v : c) std::cout << v;
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout:
      '7<0 8<1 1<14 8<14 1<0 1<7 8<7 2<15 3<16 16<9 3<9 16<15 16<2 3<2 15<0 15<1 16<1 16<7 2<7 2<8 3<8 3<14 9<14 17<10 18<11 11<4 18<4 11<10 11<17 18<17 12<5 13<6 6<19 13<19 6<5 6<12 13<12 5<10 5<11 \n64 0 0,15,10,5,1,16,11,6,7,2,17,12,8,3,18,13,14,9,4,19,\n3,5,9,1,7,2,8,321',
    uncaughtException: undefined,
  });
});

test('evaluates the operands of integer-plus-pointer from left to right', () => {
  const program = `#include <iostream>
int data[4];
int position = 0;
int offset() { std::cout << "L"; return 1; }
int* base() { std::cout << "R"; return data; }
int* buffer() { position = 2; return data; }
int main() {
  int* p = offset() + base();
  int* q = base() + offset();
  std::cout << (p - data) << (q - data) << ' ';
  int* r = position + buffer();
  std::cout << (r - data);
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: 'LRRL11 0',
    uncaughtException: undefined,
  });
});

test('composes constants from std::gcd, std::lcm, and std::clamp', () => {
  const program = `#include <algorithm>
#include <iostream>
#include <numeric>
int main() {
  constexpr int g = std::gcd(12, 8);
  constexpr int l = std::lcm(3, 4);
  constexpr int c = std::clamp(5, 1, 3);
  constexpr double d = std::clamp(0.5, 1.0, 3.0);
  int a[std::gcd(12, 8)];
  int x = 7;
  std::cout << g << ' ' << l << ' ' << c << ' ' << d << ' ' << sizeof(a) << ' ' << std::clamp(x, 1, 3) << ' ' << std::lcm(x, 2);
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '4 12 3 1 16 3 14',
    uncaughtException: undefined,
  });
});

test('composes constants from typed arithmetic functors', () => {
  const program = `#include <functional>
#include <iostream>
int main() {
  constexpr int n = std::plus<int>()(1, 2);
  constexpr bool less = std::less<int>()(1, 2);
  constexpr short wrapped = std::plus<short>()(30000, 30000);
  constexpr double half = std::divides<double>()(1, 2);
  int a[std::multiplies<int>{}(2, 3)];
  int x = 4;
  std::cout << n << less << ' ' << wrapped << ' ' << half << ' ' << sizeof(a) << ' ' << std::minus<int>()(x, 1);
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '31 -5536 0.5 24 3',
    uncaughtException: undefined,
  });
});

test('keeps functor constants and sequences typed string functor arguments', () => {
  const program = `#include <functional>
#include <iostream>
#include <string>
int main() {
  constexpr int n = std::plus<>()(1, 2);
  constexpr int braced = std::plus<>{}(1, 2);
  std::plus<> named;
  constexpr int fromNamed = named(2, 3);
  int a[std::multiplies<>()(2, 3)];
  constexpr bool less = std::less<>()(1, 2);
  std::string s[] = {"a", "b"};
  int i = 0;
  std::cout << n << braced << fromNamed << ' ' << sizeof(a) << ' ' << less << ' ' << std::plus<std::string>()(s[i++], s[i++]) << ' ' << i;
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '335 24 1 ab 2',
    uncaughtException: undefined,
  });
});

test('reads typed scalar functor operands after binding both', () => {
  const program = `#include <functional>
#include <iostream>
int value = 1;
int bump() { value = 3; return 2; }
int main() {
  std::cout << std::plus<int>()(value, bump()) << ' ';
  value = 1;
  std::cout << std::less<int>()(value, bump()) << ' ';
  value = 1;
  std::cout << std::plus<long>()(value, bump());
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '5 0 3',
    uncaughtException: undefined,
  });
});

test('evaluates transparent functor arguments as call arguments', () => {
  const program = `#include <functional>
#include <iostream>
#include <string>
int main() {
  int i = 0;
  std::cout << std::plus<>()(i++, i++) << ' ' << i << ' ';
  std::cout << std::less<>()(++i, i) << ' ';
  std::string a = "x", b(23, 'b');
  std::string c = std::plus<>()(a, b);
  std::string d = std::plus<>()(std::string(23, 'y'), b);
  std::cout << c.size() << ' ' << d.capacity() << ' ' << std::multiplies<>()(3, 4.5) << ' '
            << (std::plus<>()(1, 2) + std::minus<>()(5, 3)) << ' ' << std::equal_to<>()(a, "x");
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '1 2 0 24 55 13.5 5 1',
    uncaughtException: undefined,
  });
});

test('binds typed functor operands by const reference', () => {
  const program = `#include <functional>
#include <iostream>
#include <string>
int main() {
  std::string a(23, 'a'), b(23, 'b'), c(24, 'c');
  std::string r1 = std::plus<std::string>()(a, b);
  std::string r2 = std::plus<std::string>()(a, c);
  std::string r3 = std::plus<std::string>()(std::string(23, 'x'), b);
  std::cout << r1.capacity() << ' ' << r2.capacity() << ' ' << r3.capacity() << ' '
            << std::less<std::string>()(a, b) << std::less<std::string>()(std::string("z"), a) << std::equal_to<std::string>()(a, a) << std::greater<int>()(2, 1);
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '47 47 47 1011',
    uncaughtException: undefined,
  });
});

test('returns the std::istream base from getline', () => {
  const program = `#include <iostream>
#include <sstream>
#include <string>
void show(std::istream&) { std::cout << "base"; }
void show(std::istringstream&) { std::cout << "derived"; }
void show(std::stringstream&) { std::cout << "both"; }
int main() {
  std::istringstream input("hello\\nworld;x");
  std::stringstream both("a,b");
  std::string line;
  show(std::getline(input, line));
  show(std::getline(input, line, ';'));
  show(std::getline(both, line, ','));
  show(std::getline(std::istringstream("t"), line));
  std::istream& r = std::getline(input, line);
  std::cout << ' ' << (static_cast<void*>(&r) == static_cast<void*>(static_cast<std::istream*>(&input))) << line;
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: 'basebasebasebase 1x',
    uncaughtException: undefined,
  });
});

test('evaluates a nullptr operand before inserting it', () => {
  const program = `#include <cstddef>
#include <iostream>
std::nullptr_t f() { std::cout << 7; return nullptr; }
int main() { int x = 0; std::cout << f() << ' ' << (++x, nullptr) << x; }`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '7nullptr nullptr1',
    uncaughtException: undefined,
  });
});

test('casts stream base pointers and references back to the complete stream', () => {
  const program = `#include <iostream>
#include <sstream>
int main() {
  std::stringstream both;
  std::ostream* output = &both;
  std::istream* input = &both;
  std::ostringstream text;
  std::ostream& base = text;
  static_cast<std::ostringstream&>(base) << "ok";
  std::cout << (static_cast<std::stringstream*>(output) == &both)
            << (static_cast<std::stringstream*>(input) == &both) << ' ' << text.str();
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '11 ok',
    uncaughtException: undefined,
  });
});

test('uses the same one-past addresses for stream objects and their terminal bases', () => {
  const program = `#include <iostream>
#include <sstream>
int main() {
  std::ios* a = &std::cout;
  std::ios* b = &std::cerr;
  std::ios* c = &std::clog;
  std::ostringstream local;
  std::ios* d = &local;
  std::cout << (static_cast<void*>(a + 1) == static_cast<void*>(&std::cout + 1))
            << (static_cast<void*>(b + 1) == static_cast<void*>(&std::cerr + 1))
            << (static_cast<void*>(c + 1) == static_cast<void*>(&std::clog + 1))
            << (static_cast<void*>(d + 1) == static_cast<void*>(&local + 1));
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '1111',
    uncaughtException: undefined,
  });
});

test('copies and destroys ordered-map subtrees in libc++ order after erasure', () => {
  const program = `#include <iostream>
#include <map>
bool observed = false;
struct Value {
  int number;
  Value(int n) : number(n) {}
  Value(const Value& source) : number(source.number) { if (observed) std::cout << 'C' << number << ' '; }
  ~Value() { if (observed) std::cout << 'D' << number << ' '; }
};
int main() {
  std::map<int, Value> source, target;
  int sourceOrder[] = {6, 4, 2, 8, 7, 3, 5, 1, 9};
  int targetOrder[] = {4, 2, 6, 1, 3, 5, 7};
  for (int key : sourceOrder) source.try_emplace(key, key);
  for (int key : targetOrder) target.try_emplace(key, 10 + key);
  source.erase(6);
  observed = true;
  target = source;
  std::cout << '|';
  auto copy = target;
  std::map<int, Value> smaller;
  smaller.try_emplace(10, 10);
  std::cout << '|';
  target = smaller;
  observed = false;
  for (const auto& entry : copy) std::cout << entry.first;
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: 'C9 |C4 C2 C1 C3 C7 C5 C8 C9 |D1 D2 D3 D5 D7 D8 D9 12345789',
    uncaughtException: undefined,
  });
});

test('uses pointer addresses as unordered keys across aliasing conversions and copies', () => {
  const program = `#include <iostream>
#include <unordered_map>
#include <unordered_set>
int main() {
  int values[2]{};
  int other = 0;
  int* alias = static_cast<int*>(static_cast<void*>(values + 1));
  std::unordered_map<int*, int> map;
  map[values] = 4;
  map[values + 1] = 5;
  map[&other] = 7;
  auto copy = map;
  std::unordered_set<int*> set{values, values + 1, alias, nullptr};
  std::cout << copy[alias] << copy[values] << copy[&other] << ' ' << set.size() << ' '
            << set.count(nullptr) << set.erase(alias) << set.count(values + 1);
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '547 3 110',
    uncaughtException: undefined,
  });
});

test('uses the configured unordered load factor for reserve and clamps it at the current load', () => {
  const program = `#include <iostream>
#include <unordered_map>
#include <unordered_set>
int main() {
  std::unordered_map<int, int> map;
  map.max_load_factor(0.5f);
  map.reserve(10);
  std::cout << map.max_load_factor() << ' ' << map.bucket_count() << ' ';
  std::unordered_set<int> set{1, 2, 3, 4};
  auto buckets = set.bucket_count();
  auto load = set.load_factor();
  set.max_load_factor(load / 2);
  std::cout << (set.max_load_factor() == load) << ' ' << (set.bucket_count() == buckets);
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '0.5 23 1 1',
    uncaughtException: undefined,
  });
});

test('diagnoses a nonpositive maximum load factor', () => {
  const program = `#include <unordered_set>
int main() { std::unordered_set<int> values; values.max_load_factor(0); }`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: 'max_load_factor には正の数を渡してください。',
  });
});

test('binds every member in mixed C++ class declarations', () => {
  const program = `#include <iostream>
struct Record {
  int first(), second(int x = 2);
  int left = 4, third();
  int fourth(), right{5};
  static int high(), value;
};
int Record::first() { return 1; }
int Record::second(int x) { return x; }
int Record::third() { return left; }
int Record::fourth() { return right; }
int Record::value = 6;
int Record::high() { return value; }
int main() {
  Record record;
  std::cout << record.first() << record.second() << record.third() << record.fourth() << Record::high();
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '12456',
    uncaughtException: undefined,
  });
});

test('binds every function in mixed C++ file-scope declarations', () => {
  const program = `#include <iostream>
int first(int n = 1), second(int n = 2);
int left = 3, third();
int fourth(), right = 4;
int* pointer(), value = 5;
int main() {
  std::cout << first() << second() << third() << fourth() << *pointer();
}
int first(int n) { return n; }
int second(int n) { return n; }
int third() { return left; }
int fourth() { return right; }
int* pointer() { return &value; }`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '12345',
    uncaughtException: undefined,
  });
});

test('allows explicit outer names and unexecuted self-references during initialization', () => {
  const program = `#include <iostream>
int value = 7;
int main() {
  auto value = ::value;
  int& reference = false ? reference : value;
  static int& saved = false ? saved : ::value;
  reference = 9;
  std::cout << value << saved;
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '97',
    uncaughtException: undefined,
  });
});

test.each(['int& value = value;', 'static int& value = value;'])(
  'stops when a reference initializer uses the unbound %s',
  (declaration) => {
    const program = `int value = 7;
int main() { ${declaration} return value; }`;
    expect(executeProgram('cpp', program)).toMatchObject({
      kind: 'executed',
      uncaughtException: expect.stringContaining('値を入れていない変数'),
    });
  }
);

test('projects covariant pointer and reference results through the base subobject', () => {
  const program = `#include <iostream>
struct Base {
  virtual Base* address(bool present) { return present ? this : nullptr; }
  virtual Base& self() { return *this; }
};
struct Derived : Base {
  Derived* address(bool present) override { return present ? this : nullptr; }
  Derived& self() override { return *this; }
};
int main() {
  Derived object;
  Base* base = &object;
  std::cout << base->address(true) - base << ' ' << &base->self() - base << ' '
            << (base->address(false) == nullptr) << ' ' << (object.address(true) == &object);
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '0 0 1 1',
    uncaughtException: undefined,
  });
});

test('allows const map keys and pointers to const set elements', () => {
  const program = `#include <iostream>
#include <map>
#include <set>
int main() {
  const int n = 2;
  std::map<const int, int> counts;
  std::set<const int*> addresses;
  counts[1] = 3;
  addresses.insert(&n);
  std::cout << counts[1] << ' ' << **addresses.begin();
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '3 2',
    uncaughtException: undefined,
  });
});

test('allows forward-declared set elements until an object needs them', () => {
  const program = `#include <iostream>
#include <set>
struct Pending;
std::set<Pending>* pending = nullptr;
struct Item;
std::set<Item>* forward = nullptr;
struct Item { int value; };
int main() {
  std::set<Item> items{};
  std::cout << (pending == nullptr) << (forward == nullptr) << items.size();
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '110',
    uncaughtException: undefined,
  });
});

test.each(['set', 'multiset'])('defers owned std::%s element completeness until construction', (container) => {
  const program = `#include <iostream>
#include <set>
struct Pending;
struct Unused { std::${container}<Pending> items; };
Unused* unused = nullptr;
struct Item;
struct Owner { std::${container}<Item> items; };
struct Outer { Owner owner; };
struct Item { int value; };
int main() {
  Outer outer;
  std::cout << (unused == nullptr) << outer.owner.items.empty();
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '11',
    uncaughtException: undefined,
  });
});

test.each(['set', 'multiset'])('accepts a later definition of an owned std::%s element', (container) => {
  const program = `#include <iostream>
#include <set>
struct Item;
struct Owner { std::${container}<Item> items; };
Owner global;
int main() {
  Owner local;
  std::cout << global.items.empty() << local.items.empty();
}
struct Item { int value; };`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '11',
    uncaughtException: undefined,
  });
});

test('allows abstract types as pointer elements and in empty vector and deque storage', () => {
  const program = `#include <deque>
#include <iostream>
#include <set>
#include <vector>
struct Item;
struct Unused { std::set<Item> items; };
Unused* unused = nullptr;
struct Item { virtual void f() = 0; };
struct AlsoUnused { std::set<Item> items; };
AlsoUnused* alsoUnused = nullptr;
struct Concrete : Item { void f() override {} };
int main() {
  std::set<Item*> pointers;
  std::set<Concrete> concrete;
  std::vector<Item> vector;
  std::deque<Item> deque;
  std::cout << (unused == nullptr && alsoUnused == nullptr)
            << pointers.empty() << concrete.empty() << vector.empty() << deque.empty();
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '11111',
    uncaughtException: undefined,
  });
});

test.each([
  ['two increments', 'int i = 0;', 'i++ + i++'],
  ['a reference alias', 'int i = 1; int& r = i;', 'i++ + r'],
  ['an array element alias', 'int a[] = {1, 2}; int* p = a;', 'a[0]++ + *p'],
  ['a field alias', 'Item item{1}; int* p = &item.value;', 'item.value + (*p = 2)'],
  ['a pointer variable', 'int a[] = {1, 2}; int* p = a;', 'p++ == p'],
  ['a nested comma operator', 'int i = 0;', '(i++, 0) + i'],
  ['a fused product and addend', 'float f = 1;', '2 * f + f++'],
  ['string concatenation', "char c = 'a';", 'c++ + std::string(1, c)'],
])('rejects conflicting unsequenced C++ accesses through %s', (_name, declarations, expression) => {
  const program = `#include <iostream>
#include <string>
struct Item { int value; };
int main() {
  ${declarations}
  std::cout << (${expression});
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '',
    uncaughtException: expect.stringContaining('実行順序が決まっていない式'),
  });
});

test('preserves sequencing in shift, assignment, comma, short-circuit, and C++ function calls', () => {
  const program = `#include <iostream>
int touch(int& i) { return i++; }
int sum(int a, int b) { return a + b; }
int main() {
  int i = 0;
  std::cout << (i++, i++) << ' ' << (i++ << i) << ' ';
  i = i++ + 1;
  std::cout << (i++ && i++) << ' ' << (touch(i) + i++) << ' ' << sum(i++, i++);
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '1 16 1 13 17',
    uncaughtException: undefined,
  });
});

test.each([
  ['x++ + bytes[1]', 'int x = 0;', '&x'],
  ['x + (bytes[2] = 1)', 'int x = 0;', '&x'],
  ['bytes[1] + a[0]++', 'int a[] = {0, 9};', 'a'],
  ['bytes[1]++ + a[0]++', 'int a[] = {0, 9};', 'a'],
])('rejects overlapping unsequenced scalar and byte accesses in %s', (expression, declaration, address) => {
  const program = `#include <iostream>
int main() {
  ${declaration}
  unsigned char* bytes = static_cast<unsigned char*>(static_cast<void*>(${address}));
  std::cout << (${expression});
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '',
    uncaughtException: expect.stringContaining('実行順序が決まっていない式'),
  });
});

test('allows unsequenced accesses to separate elements through a C++ byte view', () => {
  const program = `#include <iostream>
int main() {
  int a[] = {1, 9};
  unsigned char* bytes = static_cast<unsigned char*>(static_cast<void*>(a));
  std::cout << (a[0]++ + bytes[sizeof(int)]);
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '10',
    uncaughtException: undefined,
  });
});

test('initializes C++ scalars through independent views of their bytes', () => {
  const program = `#include <iostream>
int main() {
  int x;
  unsigned char* bytes = static_cast<unsigned char*>(static_cast<void*>(&x));
  unsigned char* alias = static_cast<unsigned char*>(static_cast<void*>(&x));
  bytes[1] = 18;
  std::cout << +alias[1] << ' ';
  for (unsigned i = 0; i < sizeof(x); ++i) if (i != 1) alias[i] = 0;
  std::cout << x << ' ';
  float y;
  unsigned char* fraction = static_cast<unsigned char*>(static_cast<void*>(&y));
  for (unsigned i = 0; i < sizeof(y); ++i) fraction[i] = 0;
  std::cout << y << ' ';
  fraction[2] = 128;
  fraction[3] = 63;
  std::cout << y << ' ';
  int z;
  unsigned char* reset = static_cast<unsigned char*>(static_cast<void*>(&z));
  reset[1] = 255;
  z = 12;
  std::cout << z << ' ' << +reset[1];
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '18 4608 0 1 12 0',
    uncaughtException: undefined,
  });
});

test.each(['x', '+bytes[0]'])('rejects reading %s after a partial C++ byte initialization', (expression) => {
  const program = `#include <iostream>
int main() {
  int x;
  unsigned char* bytes = static_cast<unsigned char*>(static_cast<void*>(&x));
  bytes[1] = 5;
  std::cout << (${expression});
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '',
    uncaughtException: '値を入れていない変数（または要素）の値を読みました。',
  });
});

// Each `.out` file holds what a program built with Apple clang++ 21 (`-std=c++20`, libc++) printed, followed by the
// line libc++abi wrote when an uncaught exception ended it, if one did.
test.each(fs.readdirSync(FIXTURE_DIR).filter((name) => name.endsWith('.cpp')))(
  '%s prints what clang++ prints',
  (name) => {
    const program = fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
    const expected = fs.readFileSync(path.join(FIXTURE_DIR, name.replace(/\.cpp$/, '.out')), 'utf8');
    const execution = executeProgram('cpp', program);
    if (execution.kind !== 'executed') throw new Error(`${name} did not run: ${JSON.stringify(execution)}`);
    const uncaught = execution.uncaughtException ? `[uncaught] ${execution.uncaughtException}\n` : '';
    expect(execution.stdout + uncaught).toBe(expected);
  }
);
