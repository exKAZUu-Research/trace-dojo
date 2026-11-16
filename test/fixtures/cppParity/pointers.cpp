#include <iostream>
#include <cstring>
using namespace std;
void swapInts(int* a, int* b) { int t = *a; *a = *b; *b = t; }
void swapRefs(int& a, int& b) { int t = a; a = b; b = t; }
int sumArray(const int* arr, int n) { int s = 0; for (int i = 0; i < n; i++) s += arr[i]; return s; }
int sumArray2(int arr[], int n) { int s = 0; for (int* p = arr; p < arr + n; p++) s += *p; return s; }
struct Node { int value; Node* next; };
int main() {
  int x = 1, y = 2;
  swapInts(&x, &y); cout << x << y << endl;
  swapRefs(x, y); cout << x << y << endl;
  int arr[] = {1, 2, 3, 4, 5};
  cout << sumArray(arr, 5) << " " << sumArray2(arr, 5) << " " << *(arr + 2) << " " << &arr[3] - &arr[0] << endl;
  int* dyn = new int[4];
  for (int i = 0; i < 4; i++) dyn[i] = i * 10;
  cout << dyn[3] << endl;
  delete[] dyn;
  Node* head = nullptr;
  for (int i = 3; i >= 1; i--) head = new Node{i, head};
  for (Node* n = head; n != nullptr; n = n->next) cout << n->value;
  cout << endl;
  while (head) { Node* next = head->next; delete head; head = next; }
  int* p = new int(42); cout << *p << endl; delete p;
  char s[20] = "abc"; strcat(s, "def"); cout << s << " " << strlen(s) << " " << strcmp(s, "abd") << endl;
  char copy[20]; strcpy(copy, s); copy[0] = 'X'; cout << copy << " " << s << endl;
  const char* msg = "hello"; cout << msg << " " << msg[1] << " " << *(msg + 4) << endl;
  int matrix[3][3] = {}; matrix[1][1] = 5; cout << matrix[1][1] << endl;
  int* np = nullptr; cout << (np == nullptr) << (np ? "set" : "null") << endl;

}
