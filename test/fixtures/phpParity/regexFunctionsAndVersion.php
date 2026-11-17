<?php
echo PCRE_VERSION, "|", PCRE_VERSION_MAJOR, "|", PCRE_VERSION_MINOR, "\n";
var_dump(preg_filter('/\d/', 'N', ['a1', 'b', 'c22', 'k' => 'd3']), preg_filter('/\d/', 'N', 'abc'), preg_filter('/\d/', 'N', 'a1', -1, $c), $c);
var_dump(preg_filter(['/a/', '/b/'], ['x', 'y'], ['ab', 'cc', 'b'], 1, $c), $c);
var_dump(preg_filter('/(/', 'x', ['a']), preg_filter('/(/', 'x', 'a'));
$r = preg_replace_callback_array([
  '/\d+/' => function ($m) { echo "num {$m[0]}\n"; return $m[0] * 2; },
  '/[a-z]+/' => fn ($m) => strtoupper($m[0]),
], ['x' => 'abc 12', 'y' => 'de 3'], -1, $count);
var_dump($r, $count);
var_dump(preg_replace_callback_array(['/a/' => fn($m) => 'b', '/b/' => fn($m) => 'c'], 'aab', 1, $count), $count);
var_dump(preg_replace_callback_array(['/a/' => fn($m) => json_encode($m)], 'xa', -1, $count, PREG_OFFSET_CAPTURE));
var_dump(preg_replace_callback_array(['/(/' => fn($m) => 'b'], 'aab'));
var_dump(preg_replace_callback_array(['/(/' => fn($m) => 'b'], ['aab', 'c']));
try { preg_replace_callback_array(['nope'], 'a'); } catch (TypeError $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
try { preg_replace_callback_array(['/a/' => 'nofunc'], 'a'); } catch (TypeError $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
try { preg_filter(['/a/'], ['x'], 'a'); preg_filter('/a/', ['x'], 'a'); } catch (TypeError $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
var_dump(preg_replace_callback_array([], 'abc', -1, $count), $count);
