<?php
namespace Example;
const BASE = 1;
class ParentClass {
    const X = 1;
    function method($array = [1], $string = "long string more than ten", $constant = BASE,
                    $member = self::X, $integer = -1, $folded = 1+2, $magic = __CLASS__) {}
}
class ChildClass extends ParentClass { function method() {} }
