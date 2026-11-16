if ({}) console.log(1);
if ([]) console.log(2);
const x = "a" ? 1 : 2;
if (null) console.log(3);
function v(): void {}
if (v()) console.log(4);
class T {
  m() {
    return true;
  }
}
const t = new T();
if (t.m) console.log(5);
if (t.m) t.m();
while (1) break;
while (0) {}
