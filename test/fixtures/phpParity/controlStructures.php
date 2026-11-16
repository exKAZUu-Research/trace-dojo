<?php
for ($i = 0, $j = 10; $i < $j; $i += 3, $j -= 3) echo "$i-$j ";
echo "\n";
$n = 0; while (true) { if (++$n > 3) break; if ($n == 2) continue; echo $n; } echo "\n";
do { echo "once"; } while (false); echo "\n";
for ($i = 0; $i < 3; $i++) { for ($k = 0; $k < 3; $k++) { if ($k == 1) continue 2; if ($i == 2) break 2; echo "$i$k "; } } echo "\n";
$x = 3;
switch ($x) { case 1: echo "one"; case 3: echo "three"; case 4: echo "four"; break; default: echo "def"; }
echo "\n";
switch ("2") { case 2: echo "loose\n"; break; }
echo match(true) { $x < 2 => "small", $x < 5 => "medium", default => "large" }, "\n";
try { echo match($x) { 1 => 'a', 2 => 'b' }; } catch (\UnhandledMatchError $e) { echo get_class($e), ": ", $e->getMessage(), "\n"; }
try { echo match("x") { 1 => 'a' }; } catch (\UnhandledMatchError $e) { echo $e->getMessage(), "\n"; }
if ($x > 2): echo "alt-if\n"; elseif ($x > 1): echo "no"; else: echo "no"; endif;
foreach ([1, 2] as $v): echo $v; endforeach; echo "\n";
for ($i = 0; $i < 2; $i++): echo $i; endfor; echo "\n";
while ($x-- > 1): echo $x; endwhile; echo "\n";
switch ($x): case 0: echo "zero\n"; break; endswitch;
$i = 0;
start:
$i++;
if ($i < 3) goto start;
echo "goto $i\n";
goto skip;
echo "never\n";
skip:
echo "skipped\n";
$arr = ['a' => 1, 'b' => 2];
foreach ($arr as $key => $value) { echo "$key=$value,"; } echo "\n";
foreach ([[1, 2], [3, 4]] as [$p, $q]) echo $p + $q, " "; echo "\n";
foreach ([] as $v) echo "never"; 
foreach (null as $v) {}
echo "after\n";
$k = 5; echo $k > 3 ? "big" : "small", " ", $k ?: "zero", " ", null ?: "fallback", "\n";
echo true && false ? 'T' : 'F', true and false, "\n";
$z = false or true; var_dump($z);
echo 10 <=> 5, 'a' <=> 'b', [1,2] <=> [1,3], "\n";
