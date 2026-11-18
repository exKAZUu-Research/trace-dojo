<?php
class DebugReference {
    function __debugInfo(): array { echo "hook\n"; return ['value' => 42]; }
}
class FailingDebugReference {
    function __debugInfo(): array { echo "throwing hook\n"; throw new Exception('stop'); }
}
$object = new DebugReference;
$ref =& $object;
var_dump(['key' => &$object]);
$container = new stdClass;
$container->value =& $object;
var_dump($container);
$failure = new FailingDebugReference;
var_dump(['key' => &$failure]);
