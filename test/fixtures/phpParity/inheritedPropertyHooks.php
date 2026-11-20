<?php
class ParentSetter {
    public int $value=1 { set => $this->scale($value); }
    private function scale(int $value): int { return $value*2; }
}
class ChildGetter extends ParentSetter {
    public int $value { get => $this->value; }
}
class PlainChild extends ParentSetter { public int $value=3; }
foreach ([new ChildGetter,new PlainChild] as $object) {
    $object->value=3;
    var_dump($object->value);
}
class ParentGetter {
    public int $value=1 { get => $this->scale($this->value); }
    private function scale(int $value): int { return $value*2; }
}
class ChildSetter extends ParentGetter {
    public int $value=3 { set {} }
}
var_dump((new ChildSetter)->value);
abstract class AbstractGetter { abstract public int $value { get; } }
class ConcreteSetter extends AbstractGetter { public int $value { set => $value; } }
$abstract = new ConcreteSetter;
$abstract->value=7;
var_dump($abstract->value);

class FinalGetter { public int $value { final get => 9; } }
class FinalGetterChild extends FinalGetter { public int $value=2; }
var_dump((new FinalGetterChild)->value);
