<?php
$s = "<b>Tom & \"Jerry\"</b> 'x' `y` \x01\x7f\xe2\x82\xac < b> &amp; é";
$flagSets = [0, FILTER_FLAG_STRIP_LOW, FILTER_FLAG_STRIP_HIGH, FILTER_FLAG_STRIP_BACKTICK, FILTER_FLAG_ENCODE_LOW, FILTER_FLAG_ENCODE_HIGH, FILTER_FLAG_ENCODE_AMP, FILTER_FLAG_NO_ENCODE_QUOTES, FILTER_FLAG_EMPTY_STRING_NULL];
$filters = ['FILTER_SANITIZE_STRING' => 513, 'FILTER_SANITIZE_SPECIAL_CHARS' => FILTER_SANITIZE_SPECIAL_CHARS, 'FILTER_SANITIZE_FULL_SPECIAL_CHARS' => FILTER_SANITIZE_FULL_SPECIAL_CHARS,
  'FILTER_SANITIZE_ENCODED' => FILTER_SANITIZE_ENCODED, 'FILTER_UNSAFE_RAW' => FILTER_UNSAFE_RAW, 'FILTER_SANITIZE_EMAIL' => FILTER_SANITIZE_EMAIL, 'FILTER_SANITIZE_URL' => FILTER_SANITIZE_URL,
  'FILTER_SANITIZE_NUMBER_INT' => FILTER_SANITIZE_NUMBER_INT, 'FILTER_SANITIZE_NUMBER_FLOAT' => FILTER_SANITIZE_NUMBER_FLOAT, 'FILTER_SANITIZE_ADD_SLASHES' => FILTER_SANITIZE_ADD_SLASHES];
foreach ($filters as $name => $id) {
  echo "$name\n";
  foreach ($flagSets as $f) var_dump(filter_var($s, $id, $f));
  var_dump(filter_var('', $id, FILTER_FLAG_EMPTY_STRING_NULL), filter_var('', $id, FILTER_FLAG_EMPTY_STRING_NULL | FILTER_NULL_ON_FAILURE));
}
var_dump(filter_var("abc-1.5e3,000+x", FILTER_SANITIZE_NUMBER_FLOAT, FILTER_FLAG_ALLOW_FRACTION | FILTER_FLAG_ALLOW_THOUSAND | FILTER_FLAG_ALLOW_SCIENTIFIC));
var_dump(filter_var("a<b>c</b>", FILTER_SANITIZE_STRING));
var_dump(filter_var("<b>", FILTER_SANITIZE_STRIPPED, FILTER_FLAG_EMPTY_STRING_NULL));
var_dump(filter_var("a\0b\\'\"", FILTER_SANITIZE_ADD_SLASHES));
var_dump(filter_var("a\xffb<", FILTER_SANITIZE_FULL_SPECIAL_CHARS), filter_var("&amp; &copy; ©'", FILTER_SANITIZE_FULL_SPECIAL_CHARS), filter_var("'\"", FILTER_SANITIZE_FULL_SPECIAL_CHARS, FILTER_FLAG_NO_ENCODE_QUOTES));
var_dump(filter_var("José García <a@b.c>", FILTER_SANITIZE_EMAIL), filter_var("http://ex ample.com/ä?q=1", FILTER_SANITIZE_URL));

echo "--- arrays\n";
$data = ['age' => '25', 'email' => 'bad', 'tags' => ['1', 'x', ['3']], 'name' => '<i>Bob</i>'];
var_dump(filter_var_array($data, [
  'age' => ['filter' => FILTER_VALIDATE_INT, 'options' => ['min_range' => 1, 'max_range' => 120]],
  'email' => FILTER_VALIDATE_EMAIL,
  'tags' => ['filter' => FILTER_VALIDATE_INT, 'flags' => FILTER_REQUIRE_ARRAY],
  'name' => FILTER_SANITIZE_SPECIAL_CHARS,
  'missing' => FILTER_DEFAULT,
]));
var_dump(filter_var_array($data, ['age' => FILTER_VALIDATE_INT, 'tags' => FILTER_VALIDATE_INT, 'missing' => FILTER_DEFAULT], false));
var_dump(filter_var_array($data, FILTER_VALIDATE_INT));
var_dump(filter_var_array($data));
try { filter_var_array($data, [0 => FILTER_DEFAULT]); } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
try { filter_var_array($data, ['' => FILTER_DEFAULT]); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }
try { filter_var_array($data, ['age' => ['filter' => FILTER_VALIDATE_INT, 'flags' => FILTER_NULL_ON_FAILURE | FILTER_THROW_ON_FAILURE]]); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }
try { filter_var_array($data, ['email' => ['filter' => FILTER_VALIDATE_EMAIL, 'flags' => FILTER_THROW_ON_FAILURE]]); } catch (Filter\FilterException $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
var_dump(filter_var(['a', ['b']], FILTER_DEFAULT, FILTER_REQUIRE_ARRAY), filter_var('a', FILTER_DEFAULT, FILTER_REQUIRE_ARRAY), filter_var('a', FILTER_DEFAULT, FILTER_REQUIRE_ARRAY | FILTER_NULL_ON_FAILURE));
var_dump(filter_var(['a'], FILTER_DEFAULT, FILTER_FORCE_ARRAY), filter_var(['a'], FILTER_DEFAULT, FILTER_NULL_ON_FAILURE), filter_var(['x', '1'], FILTER_VALIDATE_INT, FILTER_FORCE_ARRAY | FILTER_NULL_ON_FAILURE));
var_dump(filter_var('3', FILTER_VALIDATE_INT, ['filter' => FILTER_VALIDATE_BOOL]));

echo "--- throw\n";
foreach ([fn() => filter_var('x', FILTER_VALIDATE_INT, FILTER_THROW_ON_FAILURE), fn() => filter_var(['x'], FILTER_VALIDATE_INT, FILTER_THROW_ON_FAILURE),
  fn() => filter_var(5, FILTER_VALIDATE_INT, FILTER_THROW_ON_FAILURE | FILTER_REQUIRE_ARRAY), fn() => filter_var(new stdClass, FILTER_VALIDATE_INT, FILTER_THROW_ON_FAILURE),
  fn() => filter_var('x', FILTER_VALIDATE_INT, ['flags' => FILTER_THROW_ON_FAILURE, 'options' => ['default' => 1]]), fn() => filter_var('7', FILTER_VALIDATE_INT, FILTER_THROW_ON_FAILURE),
  fn() => filter_var(true, FILTER_VALIDATE_INT, FILTER_THROW_ON_FAILURE | FILTER_REQUIRE_ARRAY), fn() => filter_var("a\0b", FILTER_VALIDATE_INT, FILTER_THROW_ON_FAILURE)] as $f) {
  try { var_dump($f()); } catch (Throwable $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
}
echo "--- objects\n";
class S { function __toString(): string { return '42'; } }
var_dump(filter_var(new S, FILTER_VALIDATE_INT), filter_var(new stdClass), filter_var(new stdClass, FILTER_DEFAULT, FILTER_NULL_ON_FAILURE), filter_var([new stdClass, new S], FILTER_VALIDATE_INT, FILTER_REQUIRE_ARRAY));
var_dump(filter_var(STDIN), filter_var(1.5, FILTER_VALIDATE_FLOAT), filter_var(-0.0, FILTER_VALIDATE_FLOAT));
echo "--- callback\n";
var_dump(filter_var(' x ', FILTER_CALLBACK, ['options' => 'trim']));
var_dump(filter_var([' a ', [' b ']], FILTER_CALLBACK, ['options' => 'trim']));
var_dump(filter_var(' a ', FILTER_CALLBACK, ['options' => fn($v) => false]));
try { filter_var('a', FILTER_CALLBACK, ['options' => 'no_such_function']); } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
try { filter_var_array(['a' => 'x'], ['a' => ['filter' => FILTER_CALLBACK]]); } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
var_dump(filter_var('abc', FILTER_DEFAULT, ['options' => ['default' => 1]]), filter_var('abc', 0), filter_var('abc', -1));
try { filter_var('5', FILTER_VALIDATE_INT, 'x'); } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
var_dump(FILTER_SANITIZE_STRING, FILTER_VALIDATE_BOOL, FILTER_THROW_ON_FAILURE);
var_dump(filter_var_array(['a' => '1'], ['a' => 999]));
var_dump(filter_var_array(['a' => '1', 'b' => ['2']], ['a' => ['flags' => FILTER_FLAG_ENCODE_AMP], 'b' => ['filter' => FILTER_VALIDATE_INT]]));
var_dump(new Filter\FilterFailedException('m') instanceof Exception);
$x = '10';
var_dump(filter_var($x, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1.9e30]]));
var_dump(filter_var('5', FILTER_VALIDATE_INT, ['options' => 'notarray']));
var_dump(filter_var('5', FILTER_VALIDATE_INT, ['options' => ['max_range' => '3abc']]));
var_dump(filter_var("1\x002", FILTER_VALIDATE_FLOAT, FILTER_FLAG_ALLOW_THOUSAND));
var_dump(filter_var('1_000', FILTER_VALIDATE_FLOAT, ['flags' => FILTER_FLAG_ALLOW_THOUSAND, 'options' => ['thousand' => '_']]));
var_dump(filter_var('1,000', FILTER_VALIDATE_FLOAT, ['flags' => FILTER_FLAG_ALLOW_THOUSAND, 'options' => ['thousand' => '_']]));
$a = ['x' => '1'];
$a['self'] = &$a;
var_dump(count(filter_var($a, FILTER_VALIDATE_INT, FILTER_REQUIRE_ARRAY)));
