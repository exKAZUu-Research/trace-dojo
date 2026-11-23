<?php
var_dump((int)1e20, intval(1e20), (int)-1e20, (int)NAN, (int)INF, (int)-INF, (int)1e19, (int)9.2233720368547758E+18);
var_dump(1e20 % 3, 1e20 | 0, ~1e20, 1e20 << 1, NAN % 3, INF | 0);
$c = []; $c[1e20] = 1; $c[NAN] = 2; $c[INF] = 3; var_dump($c);
var_dump(str_repeat("a", 2.5));
function f(int $x) { return $x; } var_dump(f(1e20));
var_dump((int)"9999999999999999999", (int)"-9999999999999999999", intval("99999999999999999999"), (int)"1e20", intval("1e20"), (int)"1e400", "9999999999999999999" + 0, (int)" 1e20 ");
var_dump(PHP_INT_MAX + 1 == (int)(PHP_INT_MAX + 1));
