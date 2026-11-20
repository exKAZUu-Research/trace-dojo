<?php
class ToStringOnce { function __toString(): string { echo "cast\n"; return ','; } }
var_dump(number_format(null), number_format(PHP_INT_MAX));
try { number_format([]); } catch (TypeError $error) { echo $error->getMessage(), "\n"; }
var_dump(count(array_diff([[1]])), count(array_diff([[1], [2]])), count(array_diff([new ToStringOnce])));
try { array_diff([new stdClass]); } catch (Error $error) { echo $error->getMessage(), "\n"; }
foreach ([1, null, [], 1.5, true, STDOUT, 'NoClass', new stdClass] as $value) {
    try { var_dump(get_parent_class($value)); } catch (TypeError $error) { echo $error->getMessage(), "\n"; }
}
foreach ([null, new ToStringOnce, new stdClass, ['x', 'y']] as $value) {
    try { var_dump(implode($value)); } catch (TypeError $error) { echo $error->getMessage(), "\n"; }
}
var_dump(implode(null, ['a', 'b']));
var_dump(strtr('aaa', ['a' => new ToStringOnce]));
var_dump(strtr('aaa', ['unused' => new ToStringOnce]));
var_dump(strtr('', ['a' => new ToStringOnce]));
