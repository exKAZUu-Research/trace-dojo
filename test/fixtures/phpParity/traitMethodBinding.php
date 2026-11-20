<?php
trait TextRole {
    public function __toString(): string { return 'text'; }
}
trait Runnable {
    abstract public function run(self $target): string;
    public function call(): string { return $this->run($this); }
}
class Runner {
    use TextRole, Runnable {
        call as renamed;
    }
    protected function run(self $target): string { return "ran $target"; }
}
class Child extends Runner {}
function printText(Stringable $text) { echo "$text\n"; }
printText(new Child);
echo (new Child)->renamed(), "\n";
var_export(class_implements(TextRole::class));
var_export(class_implements(Child::class));
var_export(get_class_methods(Runner::class));
trait AbstractFirst {
    abstract public function earlier(): void;
    public function later(): void {}
}
abstract class Sequence { use AbstractFirst; }
var_export(get_class_methods(Sequence::class));
