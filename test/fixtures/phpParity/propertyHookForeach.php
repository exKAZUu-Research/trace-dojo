<?php
class HookParent {
    private $hidden = 0;
    public $first = 1;
    public int $virtual { get { echo "get;"; return 2; } }
    function show() { foreach ($this as $key => $value) echo "$key:$value;"; }
}
class HookChild extends HookParent {
    public int $last = 3;
    public int $writeOnly { set {} }
}
$object = new HookChild();
foreach ($object as $key => $value) echo "$key:$value;";
echo "\n";
$object->show();
echo "\n";
echo http_build_query($object), "\n";
