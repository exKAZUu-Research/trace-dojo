<?php
$vals = [0.0, -0.0, 1.0, -1.0, 2.0, 0.5, -2.5, INF, -INF, NAN, 3, "2"];
foreach ($vals as $a) foreach ($vals as $b) echo var_export($a, true), ' ', var_export($b, true), ' => ', var_export(fpow($a, $b), true), "\n";
var_dump(fpow(10, 308), fpow(10, 309), fpow(2, -1075), fpow(-8, 1/3));
try { fpow("x", 1); } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
var_dump(fpow(null, 2));
