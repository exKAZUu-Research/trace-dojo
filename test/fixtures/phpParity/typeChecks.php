<?php
class A { public int $n = 0; public ?string $s = null; public array $list = []; public float $f = 0.0; public self|null $next = null; }
$a = new A;
$a->n = "42"; $a->f = 3; var_dump($a->n, $a->f);
try { $a->n = "abc"; } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
try { $a->list = "x"; } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
try { $a->next = new stdClass; } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
$a->n = 5.0; var_dump($a->n);
$a->n += 1; var_dump($a->n);
class U { public int $x; }
$u = new U; try { echo $u->x; } catch (Error $e) { echo $e->getMessage(), "\n"; }
var_dump(isset($u->x)); $u->x = 1; var_dump(isset($u->x)); unset($u->x); try { echo $u->x; } catch (Error $e) { echo $e->getMessage(), "\n"; }
function r1(): int { return "5"; } var_dump(r1());
function r2(): ?array { return null; } var_dump(r2());
function r3(): string { return 5; } var_dump(r3());
function r4(): bool { return 0; } var_dump(r4());
function r5(): int { return "x"; }
try { r5(); } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
function p1(?int $x) { var_dump($x); } p1(null);
function p2(iterable $it) { foreach ($it as $v) echo $v; echo "\n"; } p2([1, 2]); p2(new ArrayIterator([3]));
function p3(callable $c) { return $c(); } echo p3(fn() => "called"), p3('phpversion') !== '' ? 'Y' : 'N', "\n";
function p4(object $o) { return get_class($o); } echo p4(new A), "\n";
function p5(mixed $m = null) { return gettype($m); } echo p5(), p5([]), "\n";
function p6(int ...$nums) { return array_sum($nums); } echo p6(1, 2, 3), "\n";
try { p6(1, "x"); } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
function p7(false|string $v) { return var_export($v, true); } echo p7(false), p7("s"), "\n";
try { echo p7(true); } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
function p8(int $i) { return $i; } echo p8(true), p8(false), "\n";
function p9(string $s) { return $s; } echo p9(1.5), p9(true), "\n";
function p10(bool $b) { return var_export($b, true); } echo p10(0), p10("a"), p10(0.0), "\n";
try { p10([]); } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
function p11(int|float $n) { return var_export($n, true); } echo p11("5"), p11("5.5"), p11("1e2"), "\n";
