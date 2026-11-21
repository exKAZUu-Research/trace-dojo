<?php
declare(strict_types=1);
namespace App\Util {
    const VERSION = "1.0";
    function helper(): string { return __FUNCTION__ . " in " . __NAMESPACE__; }
    class Tool { public function name(): string { return __METHOD__ . "|" . static::class; } }
}
namespace {
    use App\Util\Tool;
    use function App\Util\helper;
    use const App\Util\VERSION;
    echo helper(), " ", VERSION, " ", (new Tool)->name(), " ", \strlen("abc"), " ", App\Util\VERSION, "\n";
    ;
    echo 0x1F, " ", 0b101, " ", 0o17, " ", 017, " ", 1_000_000, " ", .5, " ", 1e3, " ", 1_0.5_0, " ", PHP_INT_MAX, "\n";
    $a = 5; $a **= 2; $a .= "!"; echo $a, "\n";
    $b = 1; $b <<= 3; $b |= 1; $b ^= 2; $b &= 0xF; $b >>= 1; echo $b, " ", ~5, " ", 6 & 3, 6 | 3, 6 ^ 3, " ", -8 >> 1, " ", 1 << 62, "\n";
    $n = null; $n ??= "set"; $n ??= "again"; echo $n, "\n";
    var_dump(true xor true, true xor false, !empty([0]), "abc" <=> "abd");
    $r = [1, 2, 3] |> array_sum(...) |> (fn($x) => $x * 10); echo $r, "\n";
    $val = $undefined ?? "fallback"; echo $val, "\n";
    try { $x = null ?? throw new InvalidArgumentException("thrown in expr"); } catch (InvalidArgumentException) { echo "caught without var\n"; }
    $arr = [1, 2]; [$p, &$q] = $arr; $q = 20; print_r($arr);
    switch (2) { case 1; echo "one"; break; case 2; echo "two\n"; break; }
    $f = static fn() => isset($this); var_dump($f());
    try { (static function() { return $this; })(); } catch (Error $e) { echo $e->getMessage(), "\n"; }
    function strictAdd(int $a, int $b): int { return $a + $b; }
    try { echo strictAdd("1", 2); } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
    function fl(float $x): float { return $x; } var_dump(fl(5));
    function un(int|string $v): string { return gettype($v); } echo un(1), un("a"), "\n";
    function nv(): never { throw new Exception("never returns"); }
    try { nv(); } catch (Exception $e) { echo $e->getMessage(), "\n"; }
    interface A1 {} interface B1 {} class AB implements A1, B1 {}
    function inter(A1&B1 $x): string { return get_class($x); } echo inter(new AB), "\n";
    function dnf((A1&B1)|null $x): string { return $x === null ? "null" : "obj"; } echo dnf(null), dnf(new AB), "\n";
    abstract class Shape { abstract public function area(): float; public function __toString(): string { return static::class . "=" . $this->area(); } }
    final class Sq extends Shape { public function __construct(private float $s) {} public function area(): float { return $this->s ** 2; } }
    echo new Sq(3), "\n";
    readonly class Point { public function __construct(public int $x, public int $y) {} public function withX(int $x): static { return clone($this, ['x' => $x]); } }
    $pt = new Point(1, 2); $pt2 = $pt->withX(5); echo $pt->x, $pt2->x, $pt2->y, "\n";
    try { $pt->x = 9; } catch (Error $e) { echo $e->getMessage(), "\n"; }
    class Temp {
        private float $c = 0;
        public float $celsius { get => $this->c; set(float $v) { if ($v < -273.15) throw new ValueError("too cold"); $this->c = $v; } }
        public string $label { get => "T=" . $this->c; }
    }
    $t = new Temp; $t->celsius = 25; echo $t->celsius, " ", $t->label, "\n";
    try { $t->celsius = -300; } catch (ValueError $e) { echo $e->getMessage(), "\n"; }
    try { $t->label = "x"; } catch (Error $e) { echo $e->getMessage(), "\n"; }
    class Acct { public private(set) int $balance = 0; public function dep(int $n) { $this->balance += $n; } }
    $acc = new Acct; $acc->dep(10); echo $acc->balance, "\n";
    try { $acc->balance = 5; } catch (Error $e) { echo $e->getMessage(), "\n"; }
    class Consts { const A = 1; public const B = self::A + 1; protected const C = 3; private const D = 4; final public const E = 5; const int F = 6; const ARR = ['x' => 1]; public static function d() { return self::D + static::C; } }
    echo Consts::B, Consts::E, Consts::F, Consts::ARR['x'], Consts::d(), "\n";
    try { echo Consts::C; } catch (Error $e) { echo $e->getMessage(), "\n"; }
    trait Hello { public function hi() { return "Hello"; } }
    trait World { public function hi() { return "World"; } }
    class HW { use Hello, World { Hello::hi insteadof World; World::hi as protected wHi; } public function both() { return $this->hi() . " " . $this->wHi(); } }
    echo (new HW)->both(), "\n";
    $obj = new class { public $p = 1; public function __get($n) { return "magic $n"; } };
    echo $obj->p, " ", $obj->q, "\n";
    echo intdiv(PHP_INT_MIN, 1), " ", PHP_INT_MIN, "\n";
    $i = 0; while (true) { $i++; if ($i > 2) break; } echo $i, "\n";
    $s = 'abc'; echo "{$s[0]}{$s[1]}", "\n";
    $arr2 = ['one' => 1]; echo "val: $arr2[one] {$arr2['one']}\n";
    echo "done\n";
    exit("bye\n");
    echo "not printed";
}
