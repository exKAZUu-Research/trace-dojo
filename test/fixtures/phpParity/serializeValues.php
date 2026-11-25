<?php
class P { public $a = 1; protected $b = [1, 2]; private $c = "x"; public ?P $next = null; public int $typed; }
class Q extends P { private $c = "q"; public $d; }
$values = [null, true, false, 0, -42, PHP_INT_MAX, 1.5, 0.1, -0.0, 1e100, INF, -INF, NAN, "", "héllo", "a\"b\0c", [], [1, 2, 3], ['k' => 'v', 5 => [true]], new stdClass, new P, new Q];
foreach ($values as $v) {
    $s = serialize($v);
    echo str_replace("\0", '\0', $s), "\n";
    var_dump(unserialize($s));
}
$o = new stdClass; $o->x = 1; $o->self = $o;
$arr = [$o, $o, 'p' => new P];
$arr['p']->next = $arr['p'];
$s = serialize($arr);
echo str_replace("\0", '\0', $s), "\n";
$u = unserialize($s);
var_dump($u[0] === $u[1], $u[0]->self === $u[0], $u['p']->next === $u['p']);
$x = 1; $r = ['a' => &$x, 'b' => &$x, 'c' => $x];
$s = serialize($r);
echo $s, "\n";
$u = unserialize($s);
$u['a'] = 99;
var_dump($u);
$obj = new stdClass; $obj->list = [1, 2]; $obj->ref = &$obj->list;
echo serialize($obj), "\n";
$u = unserialize(serialize($obj));
$u->ref[] = 3;
var_dump($u);
try { serialize(function () {}); } catch (Exception $e) { echo get_class($e), ": ", $e->getMessage(), "\n"; }
try { serialize([1, fn() => 1]); } catch (Exception $e) { echo get_class($e), ": ", $e->getMessage(), "\n"; }
try { serialize(new class {}); } catch (Exception $e) { echo get_class($e), ": ", $e->getMessage(), "\n"; }
