<?php
error_reporting(0);
class ReattachInfo {
    function __construct(private $storage, private $object, private $label) {}
    function __destruct() {
        echo "drop:$this->label;";
        $this->storage[$this->object] = 'reattached';
        throw new Exception($this->label);
    }
}
class NativeIdentityStorage extends SplObjectStorage {}
class CallbackHashStorage extends SplObjectStorage {
    function getHash(object $object): string { return (string) $object->id; }
}
foreach ([new NativeIdentityStorage, new CallbackHashStorage] as $storage) {
    $a = (object) ['id' => 1];
    $b = (object) ['id' => 2];
    $c = (object) ['id' => 3];
    $storage[$a] = 'one';
    $storage[$b] = 'two';
    $storage[$c] = new ReattachInfo($storage, $c, 'three');
    $remove = new SplObjectStorage;
    $remove[$c] = 0;
    $remove[$a] = 0;
    $storage->next();
    try { $storage->removeAll($remove); }
    catch (Exception $error) { echo 'caught:', $error->getMessage(), ';'; }
    echo 'at:', $storage->key(), ';';
    foreach ($storage as $entry) echo $storage->getInfo(), ';';
    echo "\n";
}
