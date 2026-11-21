<?php
class StorageChild extends SplObjectStorage {}
class StorageGrandchild extends StorageChild {}
function missingSubclassKey() {
    $store = new StorageGrandchild;
    $store[new stdClass] += 1;
}
missingSubclassKey();
