<?php
function d(...$xs) { foreach ($xs as $x) { if (is_array($x)) array_walk_recursive($x, function (&$v, $k) { if ($k === 'file') $v = 'F'; }); var_dump($x); } }
class A {
  public $p = 1;
  function m($x) { $x = 'changed'; return debug_backtrace(); }
  static function s(...$r) { return debug_backtrace(DEBUG_BACKTRACE_IGNORE_ARGS); }
  function n() { return array_map(fn($v) => debug_backtrace(2, 2), [1]); }
}
function f($a, $b = 2) { return (new A)->m($a); }
d(DEBUG_BACKTRACE_PROVIDE_OBJECT, DEBUG_BACKTRACE_IGNORE_ARGS);
d(debug_backtrace());
d(f(5));
d(A::s(1, 2));
d((new A)->n());
function g() { return debug_backtrace(DEBUG_BACKTRACE_PROVIDE_OBJECT | DEBUG_BACKTRACE_IGNORE_ARGS, 1); }
d(g());
function h(...$args) { return debug_backtrace(); }
d(h(1, x: 2));
$c = function () { return debug_backtrace(); };
echo str_replace(__FILE__, 'F', json_encode($c(3), JSON_UNESCAPED_SLASHES)), "\n";
d(call_user_func('g'));
try { debug_backtrace(0, -1); } catch (Throwable $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
d(assert(false, null) ?? 1);
