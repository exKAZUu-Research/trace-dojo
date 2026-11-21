<?php
class ExitOnRemoval {
    function __destruct() { echo 'drop;'; exit; }
}
class ObserveStorageAfterExit {
    function __construct(private $storage) {}
    function __destruct() { echo count($this->storage), ':', $this->storage->key(), ';'; }
}
$first = new stdClass;
$middle = new stdClass;
$last = new stdClass;
$storage = new SplObjectStorage;
$storage[$first] = new ExitOnRemoval;
$storage[$middle] = 'middle';
$storage[$last] = 'last';
$keep = new SplObjectStorage;
$keep[$middle] = 1;
$storage->next();
$observer = new ObserveStorageAfterExit($storage);
$storage->removeAllExcept($keep);
echo 'never';
