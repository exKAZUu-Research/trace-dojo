<?php
class ThrowingShutdownChild {
    function __construct(private string $label) {}
    function __destruct() {
        echo $this->label, "\n";
        throw new Exception($this->label);
    }
}
class ThrowingShutdownParent {
    function __destruct() {
        $children = [new ThrowingShutdownChild('first'), new ThrowingShutdownChild('second')];
    }
}
$parent = new ThrowingShutdownParent();
echo "done\n";
