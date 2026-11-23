#include <iostream>
#include <string>
using namespace std;

struct Point { int x, y; } origin{0, 3};
struct Counter { int value; } first, second = {7};

struct Shape {
  virtual void describe() = 0;
  virtual ~Shape() {}
};
void Shape::describe() { cout << "a shape" << endl; }
struct Circle : Shape {
  void describe() override {
    Shape::describe();
    cout << "a circle" << endl;
  }
};

struct Header { int length; int data[0]; };

void show(char* text) { cout << "char* " << text << endl; }
void show(string text) { cout << "string " << text << endl; }
void flag(char* text) { cout << "char* " << text << endl; }
void flag(bool value) { cout << "bool " << value << endl; }

int main() {
  cout << origin.x << " " << origin.y << " " << first.value << " " << second.value << endl;

  Circle circle;
  Shape& shape = circle;
  shape.describe();

  char* word = "abc";
  cout << word << " " << word[1] << endl;
  show("literal");
  flag("literal");
  int empty[0];
  cout << sizeof(empty) << " " << sizeof(Header) << endl;

  cout << "spliced \
line" << endl;

  int arr[4] = {1, 2, 3, 4};
  int* end = &arr[4];
  int sum = 0;
  for (int* p = &arr[0]; p != end; ++p) sum += *p;
  cout << sum << " " << end - arr << endl;

  auto a = 1, b = 2;
  cout << a + b << endl;
}
