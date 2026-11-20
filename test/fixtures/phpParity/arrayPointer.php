<?php
$a = [1, 2, 3]; next($a); unset($a[1]); var_dump(current($a), key($a));
$b = [1, 2]; end($b); next($b); $b[] = 3; var_dump(current($b));
$c = [1, 2, 3]; next($c); $d = array_values($c); var_dump(current($d));
$e = [1, 2, 3]; next($e); $f = $e; var_dump(current($f)); $f[] = 4; var_dump(current($f));
$g = [1, 2, 3]; end($g); array_pop($g); var_dump(current($g));
$h = [1, 2, 3]; next($h); array_shift($h); var_dump(current($h));
$i = [1, 2, 3]; next($i); next($i); next($i); unset($i[2]); $i[] = 9; var_dump(current($i));
