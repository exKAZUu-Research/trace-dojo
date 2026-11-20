<?php
function missingObjectKey() {
    $store = new SplObjectStorage;
    $store[new stdClass]['nested'] = 'value';
}
missingObjectKey();
