<?php
use Random\Randomizer;
use Random\Engine\{Mt19937, PcgOneseq128XslRr64, Xoshiro256StarStar};
foreach ([new Mt19937(99), new PcgOneseq128XslRr64(99), new Xoshiro256StarStar(99)] as $e) {
    $r = new Randomizer($e);
    $f = [];
    for ($i = 0; $i < 8; $i++) $f[] = $r->getFloat(-1.0, 3.7);
    for ($i = 0; $i < 4; $i++) $f[] = $r->getFloat(1e-10, 2e-10);
    for ($i = 0; $i < 4; $i++) $f[] = $r->getFloat(-1e20, -1e19);
    for ($i = 0; $i < 4; $i++) $f[] = $r->nextFloat();
    echo implode(' ', array_map(fn($x) => sprintf('%.17g', $x), $f)), "\n";
    echo implode(',', $r->shuffleArray(range('a', 'z'))), "\n";
    echo $r->getBytesFromString(str_repeat('abcdefghij', 30), 20), "\n";
    echo $r->getBytesFromString('ab', 20), ' ', $r->getBytesFromString('abc', 20), "\n";
    echo implode(',', $r->pickArrayKeys(array_flip(range(1, 20)), 15)), "\n";
    echo implode(',', $r->pickArrayKeys(range(1, 20), 3)), "\n";
    for ($i = 0; $i < 6; $i++) echo $r->getInt(-3, 3), ' ', $r->getInt(0, 9999999999), ' ';
    echo "\n", bin2hex($r->getBytes(13)), ' ', $r->shuffleBytes('abcdefgh'), "\n";
}
try { new Randomizer(new stdClass); } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
$e = new Mt19937(5);
$c = clone $e;
echo bin2hex($e->generate()), bin2hex($c->generate()), "\n";
$r1 = new Randomizer($e);
echo $r1->getInt(1, 10), bin2hex($e->generate()), $r1->getInt(1, 10), "\n";
echo (new Randomizer(new Mt19937(-1)))->getInt(1, 1000), ' ', (new Randomizer(new Mt19937(PHP_INT_MAX)))->getInt(1, 1000), "\n";
echo (new Randomizer(new Xoshiro256StarStar(-5)))->nextInt(), ' ', (new Randomizer(new PcgOneseq128XslRr64(PHP_INT_MIN)))->nextInt(), "\n";
mt_srand(42); $a = mt_rand(1, 100);
echo $a, ' ', (new Randomizer(new Mt19937(42)))->getInt(1, 100), "\n";
