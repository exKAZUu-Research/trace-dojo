<?php
trait FinalAdaptation {
    public function inherited() { echo 'inherited'; }
}
class Base { use FinalAdaptation { inherited as final; } }
(new Base())->inherited();
class Derived extends Base {
    public function inherited() {}
}
