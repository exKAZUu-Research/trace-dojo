<?php
class ColumnValue {
    function __construct(public int $id) {}
    function __destruct() {
        echo "D$this->id;";
        if ($this->id === 4) throw new Exception('release failed');
    }
}
class ColumnHook {
    public int $key = 0;
    function __construct(public int $id) {}
    public ColumnValue $value {
        get {
            echo "G$this->id;";
            return new ColumnValue($this->id);
        }
    }
}
class ColumnMagic {
    public int $key = 0;
    function __construct(public int $id) {}
    function __isset(string $name): bool { return $name === 'value'; }
    function __get(string $name): ColumnValue {
        echo "M$this->id;";
        return new ColumnValue($this->id);
    }
}
$out = array_column([new ColumnHook(1), new ColumnHook(2), new ColumnHook(3)], 'value', 'key');
echo 'end;';
unset($out);
try {
    array_column([new ColumnMagic(4), new ColumnMagic(5), new ColumnMagic(6)], 'value', 'key');
} catch (Exception $e) {
    echo $e->getMessage();
}
