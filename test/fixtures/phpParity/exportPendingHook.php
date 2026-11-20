<?php
class Dropped {
    function __destruct() {
        throw new Exception('released');
    }
}
class RemoveProperty {
    public int $value { get { $GLOBALS['object']->dropped = null; return 1; } }
}
class LaterHook {
    public int $value { get { echo 'getter'; return 2; } }
}
foreach ([false, true] as $returnText) {
    $object = (object)['remove' => new RemoveProperty, 'dropped' => new Dropped];
    try {
        var_dump(var_export([$object, new LaterHook], $returnText));
    } catch (Throwable $error) {
        echo "caught:", $error->getMessage(), "\n";
    }
}
