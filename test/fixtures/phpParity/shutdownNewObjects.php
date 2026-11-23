<?php
class ShutdownRoot {
    public $cycle;
    public static $retained;
    function __destruct() {
        echo "root\n";
        $GLOBALS['globalChild'] = new ShutdownChild('global');
        self::$retained = new ShutdownChild('static');
    }
}
class ShutdownChild {
    function __construct(private string $label) {}
    function __destruct() {
        echo $this->label,'#',spl_object_id($this),"\n";
        if ($this->label==='global') $GLOBALS['grandchild'] = new ShutdownChild('grandchild');
    }
}
$freed = new stdClass;
$root = new ShutdownRoot;
$root->cycle = $root;
unset($freed);
echo "body\n";
