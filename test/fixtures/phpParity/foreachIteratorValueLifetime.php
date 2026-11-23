<?php
class IterationValue {
    function __construct(public string $label) {}
    function __destruct() {echo "drop:$this->label;";}
}
class ReturningIterator implements Iterator {
    private int $position = 0;
    function rewind(): void {$this->position = 0;}
    function valid(): bool {return $this->position < 2;}
    function current(): mixed {return new IterationValue('value' . $this->position);}
    function key(): mixed {return new IterationValue('key' . $this->position);}
    function next(): void {
        echo "advance:$this->position;";
        $this->position++;
    }
}
function visit($mode) {
    try {
        foreach (new ReturningIterator as $key => $value) {
            echo "body:$value->label;";
            if ($mode === 'unset') unset($value, $key);
            if ($mode === 'break') break;
            if ($mode === 'throw') throw new Exception('body');
        }
    } catch (Throwable $error) {echo "caught:$mode;";}
    echo "end:$mode;";
}
foreach (['retain', 'unset', 'break', 'throw'] as $mode) {
    visit($mode);
    echo "\n";
}
