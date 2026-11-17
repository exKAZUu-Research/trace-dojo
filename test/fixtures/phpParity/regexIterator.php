<?php
$a = new ArrayIterator(['apple', 'banana', 'cherry', 'avocado', 'x1', 'y22']);
foreach (new RegexIterator($a, '/^a/') as $k => $v) echo "$k=>$v\n";
foreach (new RegexIterator($a, '/(\w)(\d+)/', RegexIterator::GET_MATCH) as $k => $v) { echo "$k: "; print_r($v); }
foreach (new RegexIterator($a, '/a/', RegexIterator::ALL_MATCHES) as $k => $v) { echo "$k: "; print_r($v); }
foreach (new RegexIterator($a, '/a/', RegexIterator::SPLIT) as $k => $v) { echo "$k: "; print_r($v); }
$r = new RegexIterator($a, '/a/', RegexIterator::REPLACE);
$r->replacement = '*';
foreach ($r as $k => $v) echo "$k: $v\n";
$b = new ArrayIterator(['k1' => 'x', 'z2' => 'y', 'k3' => 'z']);
foreach (new RegexIterator($b, '/^k/', RegexIterator::MATCH, RegexIterator::USE_KEY) as $k => $v) echo "$k=>$v\n";
foreach (new RegexIterator($a, '/^a/', RegexIterator::MATCH, RegexIterator::INVERT_MATCH) as $k => $v) echo "$k=>$v\n";
$r = new RegexIterator($a, '/(a)/', RegexIterator::GET_MATCH, 0, PREG_OFFSET_CAPTURE);
foreach ($r as $k => $v) { echo "$k: "; print_r($v); break; }
var_dump($r->getMode(), $r->getFlags(), $r->getPregFlags(), $r->getRegex());
$r->setMode(RegexIterator::MATCH); $r->setFlags(RegexIterator::USE_KEY); $r->setPregFlags(0);
var_dump($r->getMode(), $r->getFlags(), $r->getPregFlags());
try { $r->setMode(9); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }
try { new RegexIterator($a, '/a/', 7); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }
var_dump(RegexIterator::USE_KEY, RegexIterator::INVERT_MATCH, RegexIterator::MATCH, RegexIterator::GET_MATCH, RegexIterator::ALL_MATCHES, RegexIterator::SPLIT, RegexIterator::REPLACE);
print_r($r); echo "\n";
$n = new ArrayIterator([1, 22, 333, 'a']);
foreach (new RegexIterator($n, '/^\d{2,}$/') as $v) echo $v, "\n";
