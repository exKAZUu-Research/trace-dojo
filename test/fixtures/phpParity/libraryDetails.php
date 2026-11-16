<?php
print_r(array_udiff([1, 5, 3], [3], fn($a, $b) => $a <=> $b)); print_r(array_uintersect(['A', 'b'], ['a'], 'strcasecmp'));
$data = [3, 1, 2]; $other = ['c', 'a', 'b']; array_multisort($data, $other); print_r($data); print_r($other);
$d2 = [1, 1, 2]; $o2 = [3, 1, 2]; array_multisort($d2, SORT_DESC, $o2, SORT_ASC); print_r($d2); print_r($o2);
$nested = [1, [2, [3]]]; array_walk_recursive($nested, function(&$v, $k) { $v *= 10; }); print_r($nested);
echo hash('sha256', 'abc'), " ", hash('crc32b', 'abc'), " ", hash('md5', ''), "\n";
var_dump(json_validate('{"a":1}'), json_validate('{a}'));
class GM { public $a = 1; protected $b = 2; private $c = 3; public function m1() {} protected function m2() {} private function m3() {} public function vars() { return get_object_vars($this); } public static function s() {} }
print_r(get_class_methods('GM')); print_r(get_object_vars(new GM)); print_r((new GM)->vars()); print_r(class_implements(new ArrayObject([])));
$v = "123"; settype($v, "integer"); var_dump($v); settype($v, "array"); var_dump($v);
var_dump(intval("101", 2), intval("0x1f", 16), intval("42", 8), intval("z", 36), intval(42.99), intval("  12 "), intval(null), intval([1]));
set_exception_handler(function($e) { echo "handled: ", $e->getMessage(), "\n"; });
trigger_error("custom notice"); trigger_error("custom warning", E_USER_WARNING); trigger_error("dep", E_USER_DEPRECATED);
$prev = set_error_handler(fn($no, $str) => print("H[$no]: $str\n")); trigger_error("via handler", E_USER_NOTICE); echo $undefined1; restore_error_handler(); echo $undefined2;
echo error_reporting(), " "; error_reporting(E_ALL & ~E_WARNING); echo $undef3, "silenced\n"; error_reporting(E_ALL);
var_dump(iterator_apply(new ArrayIterator([1, 2, 3]), fn() => true));
echo str_repeat("ab", 3), PHP_EOL;
echo gettype(STDOUT), " ", get_debug_type(STDERR), "\n"; var_dump(STDIN); echo STDOUT, "\n";
fprintf(STDOUT, "%s-%d\n", "fmt", 5); fputs(STDOUT, "puts\n");
throw new Exception("to handler");
