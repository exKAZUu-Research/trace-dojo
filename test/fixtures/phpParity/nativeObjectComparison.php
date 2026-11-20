<?php
$a = fn() => 1;
$b = fn() => 1;
var_dump($a == $b, $a <=> $b, in_array($b, [$a]), $a == $a);
var_dump(strlen(...) == strlen(...), strlen(...) == strtolower(...), join(...) == implode(...));
class Callback {
    public function method() {}
    public static function staticMethod() {}
}
class ChildCallback extends Callback {}
$cb = new Callback;
var_dump($cb->method(...) == $cb->method(...), $cb->method(...) == (new Callback)->method(...));
var_dump(Callback::staticMethod(...) == ChildCallback::staticMethod(...));
var_dump([new ArrayObject([1])] <=> [new ArrayObject([2])], new ArrayIterator([1]) == new ArrayObject([1]));
var_dump(new ArrayIterator([1]) <=> new ArrayObject([2]), new ArrayObject([2]) <=> new ArrayObject([1]));
class CustomArray extends ArrayObject { public $tag; }
$first = new CustomArray([1]);
$second = new CustomArray([1]);
$first->tag = 1;
$second->tag = 2;
var_dump($first == $second, $first <=> $second);
$key = new stdClass;
$left = new SplObjectStorage;
$right = new SplObjectStorage;
$left[$key] = 1;
$right[$key] = 2;
var_dump($left == $right, $left <=> $right, $left <=> new SplObjectStorage);
$right[$key] = 1;
var_dump($left == $right);
$left[$key] = $left;
$right[$key] = $right;
try { var_dump($left == $right); } catch (Error $e) { echo $e->getMessage(), "\n"; }
