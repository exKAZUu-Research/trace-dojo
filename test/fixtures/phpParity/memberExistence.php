<?php
trait PrivateTrait { private function fromTrait() {} }
class ParentMembers {
    use PrivateTrait;
    private $hidden = 1;
    private int $uninitialized;
    private static $staticHidden = 2;
    protected static $staticVisible = 3;
    protected $protected = 4;
    private function hiddenMethod() {}
    private static function hiddenStatic() {}
    protected function protectedMethod() {}
    public function inspect($target) {
        var_dump(property_exists($target, 'hidden'), property_exists($target, 'uninitialized'),
                 property_exists($target, 'staticHidden'), method_exists($target, 'hiddenMethod'));
    }
}
class ChildMembers extends ParentMembers { private $own; }
$child = new ChildMembers;
foreach ([ParentMembers::class, ChildMembers::class, $child] as $target) {
    var_dump(property_exists($target,'hidden'), property_exists($target,'uninitialized'),
             property_exists($target,'staticHidden'), property_exists($target,'protected'),
             property_exists($target,'staticVisible'), property_exists($target,'own'));
    var_dump(method_exists($target,'HIDDENMETHOD'), method_exists($target,'hiddenStatic'),
             method_exists($target,'protectedMethod'), method_exists($target,'fromTrait'));
}
$child->inspect($child);
$child->inspect(ChildMembers::class);
$object=(object)['present'=>null];
var_dump(property_exists($object,'present'), property_exists($object,'absent'));
class MagicMember { function __isset($name) { echo "magic"; return true; } function __call($name,$args) {} }
$magic=new MagicMember;
var_dump(property_exists($magic,'absent'), method_exists($magic,'absent'));
foreach (['property_exists','method_exists'] as $call) {
    try { $call(123, 'unknown'); } catch (Throwable $error) { echo $error->getMessage(),"\n"; }
}
