<?php
foreach ([1e15 + 0.5, 0.285, 1.955, 5.045, 5.055, -1.5, -2.5, 2.5, 3.5, 1234.5678, -0.4, 0.49999999999999994, 1.45, -1.45, 9.999999999999999e15, 0.1 + 0.7] as $v) {
  echo json_encode([round($v), round($v, 1), round($v, 2), round($v, -1), round($v, 0, PHP_ROUND_HALF_EVEN), round($v, 1, PHP_ROUND_HALF_ODD), round($v, 1, PHP_ROUND_HALF_DOWN), round($v, 0, PHP_ROUND_HALF_EVEN)]), "\n";
}
var_dump(round(1e15 + 0.5, 1), round(-0.0001, 2), round(5, 2), round(PHP_INT_MAX, -2));
