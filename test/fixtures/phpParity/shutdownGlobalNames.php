<?php
class QuietDestructor {
    function __destruct() { echo "closed\n"; }
}
$numbers = array_fill(0, 120000, 1);
extract($numbers, EXTR_PREFIX_ALL, 'n');
$object = new QuietDestructor;
