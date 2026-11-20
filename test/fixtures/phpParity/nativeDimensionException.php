<?php
function missingElement() {
    $storage = new SplObjectStorage;
    $storage[new stdClass] += 1;
}
missingElement();
