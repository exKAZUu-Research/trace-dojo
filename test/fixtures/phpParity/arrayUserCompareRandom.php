<?php
mt_srand(11);
$log = '';
$vc = function ($a, $b) use (&$log) { $log .= "v$a,$b;"; return $a <=> $b; };
$kc = function ($a, $b) use (&$log) { $log .= "k$a,$b;"; return strcmp((string)$a, (string)$b); };
$vb = function ($a, $b) use (&$log) { $log .= "b$a,$b;"; return $a > $b; };
function gen($n, $assoc) { $r = []; for ($i = 0; $i < $n; $i++) { $v = mt_rand(1, 12); if ($assoc) $r[mt_rand(0, 1) ? "k" . mt_rand(1, 15) : mt_rand(0, 15)] = $v; else $r[] = $v; } return $r; }
$fns = ['array_udiff' => 1, 'array_uintersect' => 1, 'array_diff_ukey' => 1, 'array_intersect_ukey' => 1, 'array_diff_uassoc' => 1, 'array_intersect_uassoc' => 1, 'array_udiff_uassoc' => 2, 'array_uintersect_uassoc' => 2, 'array_udiff_assoc' => 1, 'array_uintersect_assoc' => 1];
for ($round = 0; $round < 12; $round++) {
  $arrays = [];
  $count = mt_rand(1, 4);
  for ($j = 0; $j < $count; $j++) $arrays[] = gen(mt_rand(0, 40), $round % 2 == 1);
  foreach ($fns as $f => $nc) {
    $log = '';
    $cbs = $nc == 2 ? [$round % 3 == 0 ? $vb : $vc, $kc] : [str_contains($f, 'key') || str_contains($f, '_uassoc') && !str_contains($f, 'udiff_uassoc') && !str_contains($f, 'uintersect_uassoc') ? $kc : ($round % 3 == 0 ? $vb : $vc)];
    $r = $f(...$arrays, ...$cbs);
    echo "$round $f ", json_encode($r), ' ', strlen($log), ' ', crc32($log), "\n";
  }
}
