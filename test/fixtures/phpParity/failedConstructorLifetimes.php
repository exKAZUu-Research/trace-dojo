<?php
class Constructed {
    public static $escaped;
    function __construct(public int $value) {
        if ($value < 0) {
            self::$escaped = $this;
            throw new Exception('constructor');
        }
    }
    function __destruct() { echo 'destruct:', $this->value, "\n"; }
}
function failsBeforeCall() { throw new Exception('argument'); }
foreach (['constructor', 'argument', 'type', 'missing'] as $failure) {
    try {
        match ($failure) {
            'constructor' => new Constructed(-1),
            'argument' => new Constructed(failsBeforeCall()),
            'type' => new Constructed([]),
            default => new Constructed,
        };
    } catch (Throwable $error) { echo $failure, ':', get_class($error), "\n"; }
}
Constructed::$escaped = null;
class PrivateConstruction {
    private function __construct() {}
    function __destruct() { echo "unexpected private destructor\n"; }
}
try { new PrivateConstruction; }
catch (Error $error) { echo $error->getMessage(), "\n"; }
class Recovering extends Constructed {
    function __construct() {
        try { parent::__construct(-1); }
        catch (Throwable) { echo "recovered\n"; }
    }
}
$good = new Constructed(7);
$recovered = new Recovering;
Constructed::$escaped = null;
unset($recovered, $good);
