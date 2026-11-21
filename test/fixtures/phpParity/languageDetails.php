<?php
var_dump(1 ** INF, (-1) ** INF, 1 ** NAN, 1.0 ** -INF, 2 ** INF, 0.5 ** INF);
var_dump(0b1111111111111111111111111111111111111111111111111111111111111111, 0x1FFFFFFFFFFFFFFFF, 0777777777777777777777777, 0o7777777777777777777777, 9999999999999999999);
$a = [];
try { $a[[]] = 1; } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
try { echo $a[[]]; } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
try { var_dump(isset($a[[]])); } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
try { unset($a[[]]); } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
try { $a[new stdClass] = 1; } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
try { var_dump(empty($a[[]])); } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
try { var_dump(array_key_exists([], $a)); } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
$o = new stdClass; $o->p++; $o->q--; $o->r .= "x"; $o->s += 1; var_dump($o);
class C { public $z; } $c = new C; $c->w .= "a";
$x = new stdClass; $x->{'0'} = 'zero'; $x->{'12'} = 'tw'; $arr = (array)$x; var_dump($arr, isset($arr[0]), isset($arr['12']));
set_error_handler(function () { echo error_reporting(), "\n"; return true; }); echo @$undef; echo $undef2;
restore_error_handler();
set_exception_handler(function ($e) { echo "first\n"; }); set_exception_handler(function ($e) { echo "second\n"; }); restore_exception_handler();
function f() { echo "f\n"; return 0; } $b = []; $b[f()] ??= 5; var_dump($b);
throw new Exception("x");
