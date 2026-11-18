<?php
class QuietDestructor {
    function __destruct() {}
}
$objects = [];
for ($i = 0; $i < 6000; $i++) $objects[] = new QuietDestructor;
extract($objects, EXTR_PREFIX_ALL, 'obj');
echo count($objects), "\n";
