<?php
function nullable(? /* permits null */ int $value): ? /* preserves null */ int { return $value; }
print /* expression */ nullable(42);
echo "\n";
try { throw /* exception */ new Exception("caught"); }
catch (Exception $error) { echo $error->getMessage(), "\n"; }
var_dump(@ /* suppressed warning */ $undefined, nullable(null));
["x" /* key */ => $short] = ["x" => 42];
list("y" /* key */ => $long) = ["y" => 43];
foreach ([["z" => 44]] as ["z" /* key */ => $loop]) var_dump($short, $long, $loop);
