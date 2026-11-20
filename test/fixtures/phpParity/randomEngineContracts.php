<?php
foreach ([str_repeat("\0", 32), 0, str_repeat("\0", 31)."a"] as $seed) {
    try { $engine = new Random\Engine\Xoshiro256StarStar($seed); echo bin2hex($engine->generate()), "\n"; }
    catch (Throwable $error) { echo $error->getMessage(), "\n"; }
}
$engine = new Random\Engine\Mt19937(1);
$copy = clone $engine;
var_dump($engine->generate() === $copy->generate());
$random = new Random\Randomizer($engine);
try { $copy = clone $random; echo "cloned"; } catch (Throwable $error) { echo $error->getMessage(), "\n"; }
