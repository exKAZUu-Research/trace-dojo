<?php
$random = new Random\Randomizer(new Random\Engine\Mt19937(7));
foreach ([[], [1], [2,3,null], [2,3,1], [2,3], [2,3,1,1]] as $arguments) {
    try { var_dump($random->getFloat(...$arguments)); }
    catch (Throwable $e) { echo $e::class, ': ', $e->getMessage(), "\n"; }
}
