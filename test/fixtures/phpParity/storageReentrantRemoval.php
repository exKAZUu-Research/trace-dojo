<?php
error_reporting(0);
class HashRemovalStorage extends SplObjectStorage {
    function getHash(object $object): string { return (string) $object->id; }
}
class CleanupAction {
    function __construct(private Closure $action, private bool $throws) {}
    function __destruct() {
        ($this->action)();
        if ($this->throws) throw new Exception('cleanup');
    }
}
function removeExcept($targetUsesHash, $keepUsesHash, $reattach, $throws) {
    $target = $targetUsesHash ? new HashRemovalStorage : new SplObjectStorage;
    $keep = $keepUsesHash ? new HashRemovalStorage : new SplObjectStorage;
    $first = (object) ['id' => 1];
    $target[$first] = new CleanupAction(function () use ($target, $first, $reattach) {
        if ($reattach) $target[$first] = 9;
        else $target[(object) ['id' => 4]] = 4;
    }, $throws);
    $target[$middle = (object) ['id' => 2]] = 2;
    $target[(object) ['id' => 3]] = 3;
    $keep[$middle] = 0;
    $target->next();
    try { $target->removeAllExcept($keep); }
    catch (Exception $error) { echo $error->getMessage(), ';'; }
    echo count($target), '/', $target->key(), ';';
    foreach ($target as $key) echo $key->id, '=', $target->getInfo(), ',';
    echo "\n";
}
foreach ([false, true] as $targetUsesHash) {
    foreach ([false, true] as $keepUsesHash) {
        foreach ([false, true] as $reattach) {
            foreach ([false, true] as $throws) removeExcept($targetUsesHash, $keepUsesHash, $reattach, $throws);
        }
    }
}
