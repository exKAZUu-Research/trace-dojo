#include <iostream>
#include <memory>
#include <vector>
#include <string>
struct Node {
  std::string name;
  Node(std::string n) : name(std::move(n)) { std::cout << "make " << name << "\n"; }
  ~Node() { std::cout << "drop " << name << "\n"; }
};
struct Shape {
  virtual ~Shape() = default;
  virtual double area() const = 0;
};
struct Square : Shape {
  double s;
  Square(double x) : s(x) {}
  double area() const override { return s * s; }
};
struct Self : std::enable_shared_from_this<Self> {
  int v = 7;
  std::shared_ptr<Self> me() { return shared_from_this(); }
};
std::unique_ptr<Node> build(const char* n) { return std::make_unique<Node>(n); }
int main() {
  {
    auto a = std::make_unique<Node>("a");
    std::unique_ptr<Node> b = std::move(a);
    std::cout << (a == nullptr) << " " << b->name << " " << sizeof(b) << "\n";
    b.reset(new Node("c"));
    Node* raw = b.release();
    delete raw;
  }
  std::vector<std::unique_ptr<Shape>> shapes;
  shapes.push_back(std::make_unique<Square>(2));
  shapes.emplace_back(new Square(3));
  double total = 0;
  for (const auto& s : shapes) total += s->area();
  std::cout << total << "\n";
  auto u = build("u");
  {
    std::shared_ptr<Node> s1 = std::make_shared<Node>("s");
    std::cout << s1.use_count() << "\n";
    {
      auto s2 = s1;
      std::cout << s1.use_count() << " " << s2->name << "\n";
      std::weak_ptr<Node> w = s2;
      std::cout << w.use_count() << w.expired() << "\n";
      if (auto locked = w.lock()) std::cout << "locked " << locked->name << " " << s1.use_count() << "\n";
    }
    std::cout << s1.use_count() << " " << sizeof(s1) << "\n";
  }
  std::weak_ptr<Node> dangling;
  {
    auto t = std::make_shared<Node>("t");
    dangling = t;
  }
  std::cout << dangling.expired() << (dangling.lock() == nullptr) << "\n";
  auto self = std::make_shared<Self>();
  auto again = self->me();
  std::cout << again->v << " " << self.use_count() << "\n";
  std::shared_ptr<Shape> base = std::make_shared<Square>(4);
  auto sq = std::dynamic_pointer_cast<Square>(base);
  std::cout << sq->s << " " << base.use_count() << "\n";
  std::unique_ptr<int[]> arr = std::make_unique<int[]>(3);
  arr[1] = 5;
  std::cout << arr[0] << arr[1] << "\n";
  std::shared_ptr<Node> fromUnique = std::move(u);
  std::cout << fromUnique->name << " " << (u == nullptr) << "\n";
}
