#include <iostream>
class Account;
class Bank {
 public:
  int peek(const Account& a);
};
class Account {
  int balance = 100;
  mutable int reads = 0;
  friend class Auditor;
  friend int Bank::peek(const Account&);
  friend void deposit(Account& a, int n);
  friend std::ostream& operator<<(std::ostream& os, const Account& a) {
    a.reads++;
    return os << "Account(" << a.balance << ")";
  }
 public:
  int get() const { ++reads; return balance; }
  int readCount() const { return reads; }
};
void deposit(Account& a, int n) { a.balance += n; }
class Auditor {
 public:
  int audit(const Account& a) { return a.balance * 2; }
};
int Bank::peek(const Account& a) { return a.balance + 1; }
int main() {
  Account acc;
  deposit(acc, 50);
  std::cout << acc << " " << Auditor().audit(acc) << " " << Bank().peek(acc) << "\n";
  std::cout << acc.get() << " " << acc.readCount() << "\n";
}
