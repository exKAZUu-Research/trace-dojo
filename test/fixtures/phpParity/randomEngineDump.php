<?php
$x = new Random\Engine\Xoshiro256StarStar(5);
var_dump($x);
$p = new Random\Engine\PcgOneseq128XslRr64(5);
print_r($p); echo "\n";
$r = new Random\Randomizer($p);
var_dump($r);
$m = new Random\Engine\Mt19937(3);
$d = $m->__debugInfo();
echo count($d['__states']), ' ', $d['__states'][0], ' ', $d['__states'][623], ' ', $d['__states'][624], ' ', $d['__states'][625], "\n";
