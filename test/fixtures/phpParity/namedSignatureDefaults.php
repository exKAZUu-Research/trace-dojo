<?php
interface Contract { function process(int $value); }
class Incorrect implements Contract {
    function process(string $value, $a = PHP_INT_MAX, $b = PHP_EOL, $c = [M_PI], $d = PHP_INT_SIZE * 2) {}
}
