<?php
class Compared {
    public $first;
    public int $later;
}
class ChangesComparison {
    public function __toString(): string {
        $GLOBALS['left']->later = 2;
        return 'ok';
    }
}
$left = new Compared;
$right = new Compared;
$left->first = new ChangesComparison;
$right->first = 'ok';
$right->later = 2;
var_dump($left == $right);
$left->first = new stdClass;
$right->first = 1;
$left->later = 1;
set_error_handler(function () use ($left) { $left->later = 2; });
var_dump($left == $right);
restore_error_handler();
class DynamicCompared extends Compared {}
$left = new DynamicCompared;
$right = new DynamicCompared;
@$left->d = 1;
@$right->d = 1;
$left->first = new ChangesComparison;
$right->first = 'ok';
$right->later = 2;
var_dump($left == $right, isset($left->later));
