<?php
class RefArgumentLifetime {
    function __construct(public $value) {}
    function __destruct() { echo 'drop:', $this->value, ';'; }
}
function inspectAlias(&$alias, $later) { echo 'read:', $alias->value, ';'; }
function removeElement(bool $throws = false) {
    global $array;
    unset($array[0]);
    echo 'removed;';
    if ($throws) throw new Exception('argument');
}
function removeGlobal() { unset($GLOBALS['target']); echo 'removed;'; }
$array = [new RefArgumentLifetime(7)];
inspectAlias($array[0], removeElement());
echo "done\n";
$target = new RefArgumentLifetime(9);
inspectAlias($target, removeGlobal());
echo "done\n";
$array = [new RefArgumentLifetime(11)];
try { inspectAlias($array[0], removeElement(true)); }
catch (Exception $error) { echo $error->getMessage(), "\n"; }

function readSentReference(&$value, $snapshot) {
    $value = 2;
    var_dump($snapshot['sent']);
}
(function () {
    $sent = 1;
    readSentReference($sent, get_defined_vars());
})();
function inspectLocalReference() {
    $sent = 1;
    readSentReference(value: $sent, snapshot: get_defined_vars());
}
inspectLocalReference();
