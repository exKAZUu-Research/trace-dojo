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
