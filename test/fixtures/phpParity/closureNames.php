<?php
namespace App {
  function f() { return function () { return __FUNCTION__; }; }
  echo f()(), "\n";
}
namespace {
trait T { function tm() { return fn() => __METHOD__; } }
class K { use T; static function s() { return function () { return function () { return __FUNCTION__; }; }; }
  function m() { $c = fn($x) => (new Exception)->getTraceAsString(); return $c(1); } }
echo (new K)->tm()(), "\n";
echo K::s()()(), "\n";
echo (new K)->m(), "\n";
$top = fn() => __FUNCTION__; echo $top(), "\n";
$g = function () { return function () { return __METHOD__; }; }; echo $g()(), "\n";
function outer() { return function (int $x) {}; }
try { outer()("a"); } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
}
