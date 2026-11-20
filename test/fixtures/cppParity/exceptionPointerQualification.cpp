#include <iostream>

struct Base {};
struct Private : private Base {};
struct Packet { int field; };
struct Tagged;
Tagged* saved = nullptr;
struct Payload { int number = 7; };
struct Tagged : Payload {
  virtual void marker() {}
  Tagged() { saved = this; }
};

int main() {
  try { throw "error"; }
  catch (char*) { std::cout << "mutable\n"; }
  catch (const char* text) { std::cout << text << '\n'; }

  int value = 3;
  int* pointer = &value;
  try { throw &pointer; }
  catch (const int**) { std::cout << "unsafe\n"; }
  catch (const int* const* address) { std::cout << **address << '\n'; }

  try { throw static_cast<const int*>(&value); }
  catch (void*) { std::cout << "non-const\n"; }
  catch (const void*) { std::cout << "const\n"; }

  Private object;
  try { throw &object; }
  catch (Base*) { std::cout << "private base\n"; }
  catch (Private*) { std::cout << "exact pointer\n"; }

  Packet packet{7};
  try { throw &packet.field; }
  catch (void* erased) { std::cout << static_cast<Packet*>(erased)->field << '\n'; }
  try { throw &packet.field; }
  catch (void* const& erased) { std::cout << static_cast<Packet*>(erased)->field << '\n'; }

  int replacement = 9;
  try {
    try { throw &value; }
    catch (int*& address) { address = &replacement; throw; }
  } catch (int* address) {
    std::cout << *address << '\n';
  }

  try { throw Tagged{}; }
  catch (Payload& caught) {
    caught.number = 8;
    std::cout << (static_cast<void*>(&caught) == static_cast<void*>(saved))
              << (&caught == static_cast<Payload*>(saved)) << saved->number << '\n';
  }
  try { throw Tagged{}; }
  catch (const Payload& caught) {
    std::cout << (static_cast<const void*>(&caught) == static_cast<void*>(saved))
              << (&caught == static_cast<Payload*>(saved)) << caught.number << '\n';
  }
}
