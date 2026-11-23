<?php
foreach ([[NAN, 1], [1, NAN], [NAN, 1.5], [1.5, NAN], [NAN, '1'], ['1', NAN], [NAN, true], [true, NAN],
          [NAN, PHP_INT_MAX], [PHP_INT_MAX, NAN], [NAN, NAN]] as [$left, $right]) {
    $min = 'min';
    $max = 'max';
    var_dump(min($left, $right), max($left, $right), $min($left, $right), $max($left, $right),
             min([$left, $right]), max([$left, $right]));
}
var_dump(max(1, 0.0, PHP_INT_MAX, NAN), min(1, 2.0, PHP_INT_MAX, NAN));
