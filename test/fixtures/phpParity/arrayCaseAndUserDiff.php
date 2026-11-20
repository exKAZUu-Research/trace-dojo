<?php
foreach ([
  fn() => array_udiff(),
  fn() => array_udiff([1]),
  fn() => array_udiff([1], 'nope'),
  fn() => array_udiff([1], 5, 'strcmp'),
  fn() => array_udiff_uassoc([1], [2], 'strcmp'),
  fn() => array_udiff_uassoc([1], 'strcmp'),
  fn() => array_udiff_uassoc([1], 'strcmp', 'nope'),
  fn() => array_uintersect_assoc([1], 3, 'strcmp'),
  fn() => array_uintersect_assoc(3, [1], 'strcmp'),
  fn() => array_intersect_ukey([1], [1], 'nope'),
  fn() => array_change_key_case(5),
  fn() => array_udiff([1], 'strcmp'),
] as $i => $f) {
  try { var_dump($f()); } catch (Throwable $e) { echo $i, ' ', get_class($e), ': ', $e->getMessage(), "\n"; }
}
