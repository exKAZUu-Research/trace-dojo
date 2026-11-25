#include <iostream>
#include <string>
#include <vector>
struct Drawable {
  virtual ~Drawable() { std::cout << "~Drawable\n"; }
  virtual void draw() const = 0;
  int layer = 1;
};
struct Named {
  std::string label;
  Named(std::string s) : label(std::move(s)) {}
  virtual ~Named() { std::cout << "~Named " << label << "\n"; }
  virtual std::string name() const { return "named:" + label; }
  void rename(const std::string& s) { label = s; }
};
struct Circle : public Drawable, public Named {
  double r;
  Circle(double radius) : Named("circle"), r(radius) {}
  ~Circle() override { std::cout << "~Circle\n"; }
  void draw() const override { std::cout << "circle " << r << " " << label << " " << layer << "\n"; }
  std::string name() const override { return "Circle(" + label + ")"; }
};
void show(const Named& n) { std::cout << n.name() << "\n"; }
int main() {
  {
    Circle c(2);
    c.draw();
    show(c);
    Named* n = &c;
    n->rename("round");
    std::cout << n->name() << " " << c.label << "\n";
    Drawable* d = &c;
    d->draw();
    Circle* back = static_cast<Circle*>(n);
    std::cout << back->r << " " << (dynamic_cast<Circle*>(n) != nullptr) << "\n";
    std::cout << sizeof(Circle) << "\n";
  }
  std::vector<Named*> items;
  items.push_back(new Circle(1));
  for (Named* item : items) {
    std::cout << item->name() << "\n";
    delete item;
  }
}
