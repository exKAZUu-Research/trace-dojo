<?php
$a=[]; $a[0]=&$a; $b=[]; $b[0]=&$b;
try { var_dump($a == $b); } catch (Error $e) { echo $e->getMessage(), "\n"; }
try { var_dump($a === $b); } catch (Error $e) { echo $e->getMessage(), "\n"; }
try { var_dump($a <=> $b); } catch (Error $e) { echo $e->getMessage(), "\n"; }
var_dump([1, [2]] == [1, [2]], [1, [2]] === [1, [2]], [1, [2]] <=> [1, [3]]);
