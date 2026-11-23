<?php
function d(...$xs) { foreach ($xs as $x) { if (is_array($x)) array_walk_recursive($x, function (&$v, $k) { if ($k === 'file') $v = 'F'; }); var_dump($x); } }
trait T1 {} trait T2 { use T1; } trait T3 {}
class P { use T3; }
class C extends P { use T2, T1; use T3; }
d(class_uses(new C), class_uses('C'), class_uses('P'), class_uses('T2'), class_uses('stdClass'));
d(class_uses('Nope'));
d(class_uses('Nope', false));
d(class_implements('Nope'), class_parents('Nope'));
try { class_uses(5); } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
d(error_get_last());
echo $undef1;
d(error_get_last());
error_clear_last();
d(error_get_last());
@$x = 1 / 1 + $undef2;
d(error_get_last());
set_error_handler(function ($no, $str) { echo "handler: $str\n"; return true; });
echo $undef3;
d(error_get_last());
set_error_handler(function ($no, $str) { echo "handler2: $str\n"; return false; });
echo $undef4;
d(error_get_last());
restore_error_handler(); restore_error_handler();
error_reporting(0);
trigger_error("quiet", E_USER_WARNING);
d(error_get_last());
error_reporting(E_ALL);
function f() { strlen(); }
try { f(); } catch (ArgumentCountError $e) {}
d(error_get_last());
trigger_error("dep", E_USER_DEPRECATED);
print_r(error_get_last());
d(error_clear_last());
