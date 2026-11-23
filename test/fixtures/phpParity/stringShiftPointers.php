<?php $a=['a'=>1,'b'=>2,'c'=>3];next($a);var_dump(array_shift($a),key($a));$a[]=4;var_dump($a);
