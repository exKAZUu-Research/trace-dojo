<?php
class ColumnValue {
    public function __construct(public int $label) {}
    public function __destruct() { echo "drop $this->label;"; }
}
class ExitingRow {
    public int $key = 0;
    public function __construct(public int $id) {}
    public ColumnValue $value {
        get {
            echo "read $this->id;";
            if ($this->id === 2) exit;
            return new ColumnValue($this->id);
        }
    }
}
$last = new ColumnValue(9);
array_column([new ExitingRow(1), new ExitingRow(2)], 'value', 'key');
