<?php
class ReduceValue {
    public function __construct(public string $label) {}
    public function __destruct() { echo "drop $this->label;"; }
}

foreach ([false, true] as $array) {
    $result = array_reduce([1, 2, 3], function ($carry, $item) use ($array) {
        echo "item $item;";
        return $carry ?? ($array ? [new ReduceValue('array')] : new ReduceValue('object'));
    });
    echo $array ? count($result) : $result->label, ';end;';
    unset($result);
    echo "\n";
}

try {
    array_reduce([1, 2, 3], function ($carry, $item) {
        echo "item $item;";
        if ($item === 3) throw new Exception('callback');
        return [new ReduceValue("carry $item")];
    });
} catch (Exception $e) {
    echo $e->getMessage(), "\n";
}

$result = array_reduce([1, 2, 3], function ($carry, $item) {
    echo "item $item;";
    return $item === 1 ? [new ReduceValue('before scalar')] : $item;
});
echo $result, ";end;\n";
