<?php
function receiveUntyped($value) { var_dump($value); }
function receiveMixed(mixed $value) { var_dump($value); }
function receiveNumber(float|int $value) { var_dump($value); }
function receiveFloat(float $value) { var_dump($value); }
function receiveString(string $value) { var_dump($value); }
class UndefinedChild extends RecursiveArrayIterator {
    function __construct($items, private bool $child = false) { parent::__construct($items); }
    function getChildren(): ?RecursiveArrayIterator { return new self($this->current(), true); }
    function __destruct() {
        if (!$this->child) return;
        global $iterator;
        foreach (['getSubIterator', 'getInnerIterator'] as $getter) {
            unset($original, $alias, $bound, $referenced);
            echo $getter, ":\n";
            $read = fn () => $iterator->$getter();
            $literal = ['hole' => $read()];
            $stored = [];
            $stored['hole'] = $read();
            foreach ([$literal, $stored] as $array) {
                var_dump(array_key_exists('hole', $array), isset($array['hole']), count($array), $array);
                var_dump($array === ['hole' => null], array_keys($array), array_values($array));
                foreach ($array as $entry) echo 'unexpected entry';
            }
            $original = $read();
            $alias = &$original;
            var_dump($original, $alias);
            $original = $read();
            $referenced = ['hole' => &$alias];
            var_dump(isset($original), isset($alias), isset($referenced['hole']), $referenced === ['hole' => null]);
            $alias ??= 42;
            var_dump($original, $alias);
            var_dump(intval($read()), (int) $read(), floatval($read()), (float) $read());
            var_dump(strlen($read()), strtoupper($read()), trim($read()), abs($read()));
            try { count($read()); }
            catch (TypeError $error) { echo $error->getMessage(), "\n"; }
            receiveUntyped($read());
            receiveMixed($read());
            receiveNumber($read());
            receiveFloat($read());
            receiveString($read());
            $bound = $read();
            var_dump(compact(['bound']), extract(['bound' => 'taken'], EXTR_SKIP | EXTR_REFS), $bound);
            $bound = $read();
            foreach ($read() as $entry) echo 'unexpected entry';
            echo "complete\n";
        }
    }
}
$iterator = new RecursiveIteratorIterator(new UndefinedChild([[1], 2]));
foreach ($iterator as $ignored) {}
