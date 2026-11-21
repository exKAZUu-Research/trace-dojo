<?php
$a = [1, [2]]; [$x, [&$y]] = $a; $y = 9; var_dump($a);
[&$p] = f();
function f() { static $s = [1]; return $s; }
