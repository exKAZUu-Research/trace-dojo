<?php
var_dump(array_sum(['abc', 1, '4x', [1], null, true]));
var_dump(array_product(['a', 2]));
unset($u1["k"]);
unset($u2->p);
unset($u3[0][1]);
try { $u4->prop = 1; } catch (Error $e) { echo $e->getMessage(), "\n"; }
echo $GLOBALS['nn'] ?? 'dflt', "\n";
echo $GLOBALS['nn2'];
try { $n = null; $n(); } catch (Error $e) { echo $e->getMessage(), "\n"; }
try { $n = 5; $n(); } catch (Error $e) { echo $e->getMessage(), "\n"; }
try { [1, 2](); } catch (Error $e) { echo $e->getMessage(), "\n"; }
try { array_map('nope', [1]); } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
try { array_filter([1], 'nope'); } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
try { usort($undef, 'nope'); } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
try { array_walk($undef2, fn() => 1); } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
try { clone 5; } catch (Error $e) { echo get_class($e), ": ", $e->getMessage(), "\n"; }
class PC { private function __clone() {} } try { clone new PC; } catch (Error $e) { echo $e->getMessage(), "\n"; }
try { array_merge([1], 2); } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
try { array_map(fn($a, $b) => 1, [1], 3); } catch (TypeError $e) { echo $e->getMessage(), "\n"; }

class BracedMembers {
    public $value = 'property';
    public $MEMBER_KEY = 'plain name';
    public static $shared = 'shared';
    function value() { echo "method\n"; }
    static function read() { echo "static method\n"; }
}
const MEMBER_KEY = 'value', METHOD_KEY = 'read', STATIC_KEY = 'shared';
$members = new BracedMembers();
$members->{/* Fetch the constant. */ MEMBER_KEY}();
BracedMembers::{METHOD_KEY}();
echo BracedMembers::${STATIC_KEY}, "\n";
echo $members?->{MEMBER_KEY}, ';', $members->MEMBER_KEY, "\n";
$members->{MEMBER_KEY} = 'changed';
var_dump(isset($members->{MEMBER_KEY}), $members->value);
unset($members->{MEMBER_KEY});
var_dump(isset($members->value));
try {
    $index = 1;
    $members
        ->{
          $index
        }();
} catch (Error $error) { echo $error->getLine(), ':', $error->getMessage(), "\n"; }
try { $members->{true ? 1 : 2}(); }
catch (Error $error) { echo $error->getMessage(), "\n"; }
$name = [];
var_dump(isset($missingBase->$name), empty($missingBase[0]->$name), $missingBase->x->$name ?? 1);
$name = new stdClass();
var_dump(isset($missingBase->$name), $missingBase->$name ?? 'default');
var_dump(isset($missingBase->$unboundName));
