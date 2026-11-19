#include <iostream>

struct Base { int value = 7; };
struct Hidden : private Base {};
struct Nested { Base base; double next; };
struct Derived : Base {};
struct Cell {
  Cell* self;
  Cell() : self(this) {}
};
struct Row { Cell cell; };
struct Table { Row row; };

int main() {
  int values[] = {1, 0x11223344};
  void* erased = values + 1;
  int* exact = static_cast<int*>(erased);
  unsigned int* corresponding = static_cast<unsigned int*>(erased);
  unsigned char* bytes = static_cast<unsigned char*>(erased);
  std::cout << (exact == values + 1) << ' ' << corresponding[-1] << ' '
            << int(bytes[0]) << ' ' << int(bytes[3]) << '\n';
  *corresponding = 0x11223355u;
  bytes[1] = 0x66;
  void* erasedAgain = bytes;
  std::cout << std::hex << *static_cast<int*>(erasedAgain) << '\n';
  const void* nil = nullptr;
  std::cout << (static_cast<const int*>(nil) == nullptr) << '\n';
  Hidden hidden;
  std::cout << ((Base&)hidden).value << '\n';
  Nested nested{{8}, 2};
  void* erasedNested = &nested;
  int* first = static_cast<int*>(erasedNested);
  std::cout << *first << ' ' << (*static_cast<Nested*>(static_cast<void*>(&nested.base))).base.value << '\n';
  std::cout << static_cast<Nested*>(static_cast<void*>(&nested.base.value))->base.value << '\n';
  Base base;
  void* erasedMember = &base.value;
  std::cout << static_cast<Base*>(erasedMember)->value << ' ' << (static_cast<Base*>(erasedMember) == &base) << '\n';
  Derived derived;
  void* erasedDerived = &derived;
  Base* recoveredBase = static_cast<Base*>(erasedDerived);
  std::cout << recoveredBase->value << ' ' << (static_cast<Derived*>(static_cast<void*>(recoveredBase)) == &derived) << '\n';
  const void* heapValue = new int(9);
  const int* heapInt = static_cast<const int*>(heapValue);
  std::cout << *heapInt << '\n';
  delete heapInt;

  Table table;
  Table* recovered = static_cast<Table*>(static_cast<void*>(table.row.cell.self));
  std::cout << recovered - &table << '\n';
  Table* heapTable = new Table;
  Table* recoveredHeap = static_cast<Table*>(static_cast<void*>(heapTable->row.cell.self));
  std::cout << (recoveredHeap == heapTable) << '\n';
  delete recoveredHeap;
}
