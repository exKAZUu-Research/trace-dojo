<?php
interface Contract { function process(int $value); }
class Ancestor {}
class Incorrect extends Ancestor implements Contract {
    function process(string $value, $a = PHP_INT_MAX, $b = PHP_EOL, $c = [M_PI], $d = PHP_INT_SIZE * 2, $e = self::class, $f = parent::class, $g = 'x' . self::class, $h = null ?? PHP_OS, $i = 1 ? PHP_EOL : 2) {}
}
