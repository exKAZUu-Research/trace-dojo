<?php
function readonly() { return 'readonly'; }
class Subject {}
function switchValue() { switch (1) { ; case 1: return 'switch'; } }
print 0 or print 3;
print $assigned = 8;
echo ':', $assigned, ';', match (1) { default, => readonly() }, ':', switchValue(), "\n";
$value = new Subject;
var_dump(!$value instanceof Subject, $value instanceof Subject instanceof Subject);
$value = 2;
var_dump(-$value instanceof Subject, $value ** 2 instanceof Subject, ~$value instanceof Subject);
$value = new Subject;
foreach ([fn() => -$value instanceof Subject, fn() => +$value instanceof Subject,
          fn() => 2 ** $value instanceof Subject, fn() => ~$value instanceof Subject] as $expression) {
    try { var_dump($expression()); }
    catch (TypeError $error) { echo $error->getMessage(), "\n"; }
}
