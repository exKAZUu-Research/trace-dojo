<?php
$bytes = ["\x41", "\x80", "\xbf", "\xc1", "\xc2", "\xdf", "\xe0", "\xe3", "\xed", "\xef", "\xf0", "\xf1", "\xf4", "\xf5", "\xff", "\x90", "\xa0", "\x9f"];
$out = [];
foreach ($bytes as $a) foreach ($bytes as $b) foreach ($bytes as $c) {
  $s = $a . $b . $c;
  $out[] = bin2hex(mb_scrub($s)) . ":" . (mb_check_encoding($s) ? 1 : 0);
}
echo md5(implode(",", $out)), "\n";
$out = [];
foreach ($bytes as $a) foreach ($bytes as $b) foreach ($bytes as $c) foreach (["\x80", "\x90\x80", "A"] as $d) { $s = $a . $b . $c . $d; $out[] = bin2hex(mb_scrub($s)); }
echo md5(implode(",", $out)), "\n";
