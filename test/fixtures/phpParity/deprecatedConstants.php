<?php
mt_srand(3, MT_RAND_PHP); var_dump(mt_rand(), mt_rand(1, 6), constant("MT_RAND_PHP"));
$o = new ArrayObject([1, "a" => 2]); var_dump((array)$o, (array)$o->getIterator());
