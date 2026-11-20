<?php
foreach ([[5, 33], [10, 33], [2, 63], [2, 64], [2, 65], [-5, 33], [3, 64], [7, 128], [1, PHP_INT_MAX], [-1, PHP_INT_MAX], [0, 100]] as [$base, $exponent]) {
    var_dump($base ** $exponent);
}
var_dump(5.0 ** 33, 10.0 ** 33);
