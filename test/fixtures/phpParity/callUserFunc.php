<?php
function check($v) { echo (new Exception)->getTraceAsString(), "\n"; }
call_user_func('check', 1);
call_user_func_array('check', [5]);
call_user_func_array('check', ['v' => 7]);
array_map('call_user_func', ['check'], [9]);
function need($a, $b) {}
try { call_user_func('need', 1); } catch (ArgumentCountError $e) { echo $e->getMessage(), "\n"; }
function byref(&$x) { $x++; }
$n = 1; call_user_func('byref', $n); var_dump($n);
class C { function m($x) { throw new Exception("m"); } }
try { call_user_func([new C, 'm'], 3); } catch (Exception $e) { echo $e->getTraceAsString(), "\n"; }
call_user_func(fn() => check(2));
