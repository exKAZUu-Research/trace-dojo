<?php
class ReplacedProperty {
    public $live = 'live';
    function __destruct() { echo "drop;\n"; }
}
class ReplaceInInspector {
    function __debugInfo() {
        $GLOBALS['owner']->later = null;
        return [];
    }
}
class ReplaceInExport {
    public $replace {
        get {
            $GLOBALS['owner']->later = null;
            return 'hook';
        }
    }
}
foreach (['var_dump', 'print_r', 'var_export'] as $inspect) {
    $owner = (object)['first' => $inspect === 'var_export' ? new ReplaceInExport : new ReplaceInInspector];
    $owner->later = new ReplacedProperty;
    $inspect($owner);
    echo "\n";
}
