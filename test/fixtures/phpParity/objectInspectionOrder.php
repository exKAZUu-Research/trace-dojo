<?php
class HooksForExport {
    private int $privateValue { get => 12; }
    protected string $readable { get => 'included'; }
    public int $backed = 4 { get => $this->backed * 2; }
    public $writeOnly { set {} }
    public int $uninitialized;
}
class FixedForExport extends SplFixedArray {
    public $name = 'fixed';
    private $extra = 3;
}
$fixed = new FixedForExport(2);
$fixed[1] = 10;
var_export(new HooksForExport); echo "\n";
var_export($fixed); echo "\n";
class DebugNested {
    function __debugInfo(): array { echo "nested hook\n"; return ['label' => 'nested']; }
}
var_dump([1, new DebugNested, 3]);
class DebugFailure {
    function __debugInfo(): array { echo "before throw\n"; throw new Exception('broken'); }
}
var_dump([4, new DebugFailure, 5]);
