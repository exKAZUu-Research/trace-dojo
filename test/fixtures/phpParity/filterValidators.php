<?php
foreach (filter_list() as $f) echo $f, ' ', filter_id($f), "\n";
var_dump(filter_id('nope'), filter_has_var(INPUT_GET, 'x'), filter_has_var(INPUT_POST, 'x'));
try { filter_has_var(9, 'x'); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }

echo "--- int\n";
$ints = ['42', ' 42 ', "\t-7\n", '+0', '-0', '00', '0', '007', '0x1A', '0X1a', '0x', '0o17', '017', '0o', '1e3', '1.0', '', ' ', 'abc',
  '9223372036854775807', '9223372036854775808', '-9223372036854775808', '-9223372036854775809', '0xFFFFFFFFFFFFFFFF', '0x10000000000000000',
  '01777777777777777777777', "\f1", '12abc', '+', '-'];
foreach ($ints as $v) {
  echo json_encode($v), ': ';
  var_dump(filter_var($v, FILTER_VALIDATE_INT), filter_var($v, FILTER_VALIDATE_INT, FILTER_FLAG_ALLOW_HEX | FILTER_FLAG_ALLOW_OCTAL));
}
var_dump(filter_var('5', FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 4]]));
var_dump(filter_var('5', FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 4, 'default' => 3]]));
var_dump(filter_var('5', FILTER_VALIDATE_INT, ['options' => ['min_range' => '6']]));
var_dump(filter_var('x', FILTER_VALIDATE_INT, ['options' => ['default' => 'dflt'], 'flags' => FILTER_NULL_ON_FAILURE]));
var_dump(filter_var('x', FILTER_VALIDATE_INT, FILTER_NULL_ON_FAILURE));
var_dump(filter_var(12, FILTER_VALIDATE_INT), filter_var(12.0, FILTER_VALIDATE_INT), filter_var(12.5, FILTER_VALIDATE_INT), filter_var(true, FILTER_VALIDATE_INT), filter_var(null, FILTER_VALIDATE_INT));

echo "--- bool\n";
foreach (['1', 'true', 'TRUE', ' on ', 'yes', 'Yes', '0', 'false', 'off', 'no', '', ' ', 'maybe', '2', 'nope', null, true, false, 1, 0] as $v) {
  echo json_encode($v), ': ';
  var_dump(filter_var($v, FILTER_VALIDATE_BOOLEAN), filter_var($v, FILTER_VALIDATE_BOOL, FILTER_NULL_ON_FAILURE));
}
var_dump(filter_var('no', FILTER_VALIDATE_BOOL, ['options' => ['default' => 'D']]));

echo "--- float\n";
$floats = ['1.5', ' 1.5 ', '-1.5e3', '1e400', '1e-400', '0e5', '0.0', '.5', '5.', '+.5', '1,000.5', '1,000,000', '1,00', '1.000,5', "1'000", '1 000', 'abc', '', '12', '-0', '1e', '1E+2', '0x1A'];
foreach ($floats as $v) {
  echo json_encode($v), ': ';
  var_dump(filter_var($v, FILTER_VALIDATE_FLOAT), filter_var($v, FILTER_VALIDATE_FLOAT, FILTER_FLAG_ALLOW_THOUSAND));
}
var_dump(filter_var('1.000,5', FILTER_VALIDATE_FLOAT, ['options' => ['decimal' => ','], 'flags' => FILTER_FLAG_ALLOW_THOUSAND]));
var_dump(filter_var('1 000,5', FILTER_VALIDATE_FLOAT, ['options' => ['decimal' => ',', 'thousand' => ' '], 'flags' => FILTER_FLAG_ALLOW_THOUSAND]));
var_dump(filter_var('5.5', FILTER_VALIDATE_FLOAT, ['options' => ['min_range' => 1, 'max_range' => 5]]));
var_dump(filter_var('5', FILTER_VALIDATE_FLOAT, ['options' => ['min_range' => 1, 'max_range' => 5]]));
try { filter_var('1', FILTER_VALIDATE_FLOAT, ['options' => ['decimal' => '..']]); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }
try { filter_var('1', FILTER_VALIDATE_FLOAT, ['options' => ['thousand' => '']]); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }
var_dump(filter_var('', FILTER_VALIDATE_FLOAT, ['options' => ['decimal' => '..']]));
echo "--- email\n";
$emails = ['user@example.com', 'User.Name+tag@sub.example.co.jp', 'user@localhost', 'user@@example.com', 'user@example', '"quoted user"@example.com',
  'user@[127.0.0.1]', 'user@[IPv6:2001:db8::1]', 'üser@example.com', 'user@exämple.com', 'a@b.c', '.user@example.com', 'user.@example.com',
  'us..er@example.com', 'user@-example.com', 'user@example.com.', str_repeat('a', 65) . '@example.com', 'user@xn--exmple-cua.com', ' user@example.com', '', 'user@123.com', 'test@example.c0m'];
foreach ($emails as $v) {
  echo json_encode($v), ': ';
  var_dump(filter_var($v, FILTER_VALIDATE_EMAIL), filter_var($v, FILTER_VALIDATE_EMAIL, FILTER_FLAG_EMAIL_UNICODE));
}
echo "--- url\n";
$urls = ['http://example.com', 'https://example.com/path?q=1#frag', 'http://localhost:8080/', 'example.com', 'http://', 'http:/example.com',
  'ftp://ftp.example.com/file.txt', 'mailto:user@example.com', 'news:comp.lang.php', 'file:///etc/passwd', 'foo://bar', 'http://exa mple.com',
  'http://user:pass@example.com', 'http://us%20er@example.com', 'http://us%2Fer@example.com', 'http://-bad.com', 'http://bad-.com', 'http://a_b.com',
  'http://[::1]/', 'http://[::g]/', 'http://192.168.0.1/', 'http://example.com:99999', 'javascript:alert(1)', 'http://日本.jp', 'HTTP://EXAMPLE.COM', 'https://a.b'];
foreach ($urls as $v) {
  echo json_encode($v), ': ';
  var_dump(filter_var($v, FILTER_VALIDATE_URL), filter_var($v, FILTER_VALIDATE_URL, FILTER_FLAG_PATH_REQUIRED), filter_var($v, FILTER_VALIDATE_URL, FILTER_FLAG_QUERY_REQUIRED));
}
echo "--- ip\n";
$ips = ['127.0.0.1', '192.168.1.1', '10.0.0.1', '172.16.0.1', '8.8.8.8', '0.0.0.0', '255.255.255.255', '169.254.1.1', '100.64.0.1', '192.88.99.1', '192.0.2.1',
  '256.1.1.1', '1.2.3', '01.2.3.4', '1.2.3.4.5', '::1', '::', '2001:db8::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', '2001:4860:4860::8888', '::ffff:192.168.1.1',
  '1::2::3', '1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7:8:9', '12345::1', ':1:2', '1:', '64:ff9b::1.2.3.4', 'abc', '', '1:2:3:4:5:6:1.2.3.4', '2001:10::1', '2002::1', '::ffff:1.2.3.4'];
$flags = [0, FILTER_FLAG_IPV4, FILTER_FLAG_IPV6, FILTER_FLAG_NO_PRIV_RANGE, FILTER_FLAG_NO_RES_RANGE, FILTER_FLAG_GLOBAL_RANGE, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE];
foreach ($ips as $v) {
  echo json_encode($v), ':';
  foreach ($flags as $f) echo ' ', var_export(filter_var($v, FILTER_VALIDATE_IP, $f), true);
  echo "\n";
}
echo "--- mac\n";
foreach (['01:23:45:67:89:ab', '01-23-45-67-89-AB', '0123.4567.89ab', '01:23:45:67:89', '01:23-45:67:89:ab', 'gg:23:45:67:89:ab', '0123:4567:89ab'] as $v) {
  echo json_encode($v), ': ';
  var_dump(filter_var($v, FILTER_VALIDATE_MAC), filter_var($v, FILTER_VALIDATE_MAC, ['options' => ['separator' => '-']]));
}
try { filter_var('01:23:45:67:89:ab', FILTER_VALIDATE_MAC, ['options' => ['separator' => '--']]); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }
echo "--- domain\n";
foreach (['example.com', 'example.com.', '-example.com', 'exa_mple.com', 'a-.com', 'a-.', 'a..b', '.', '', 'localhost', str_repeat('a', 64) . '.com', str_repeat('a', 63) . '.com', 'ex ample.com', '1.2.3.4'] as $v) {
  echo json_encode($v), ': ';
  var_dump(filter_var($v, FILTER_VALIDATE_DOMAIN), filter_var($v, FILTER_VALIDATE_DOMAIN, FILTER_FLAG_HOSTNAME));
}
echo "--- regexp\n";
var_dump(filter_var('abc123', FILTER_VALIDATE_REGEXP, ['options' => ['regexp' => '/^[a-z]+\d+$/']]));
var_dump(filter_var('abc', FILTER_VALIDATE_REGEXP, ['options' => ['regexp' => '/^\d+$/']]));
var_dump(filter_var('abc', FILTER_VALIDATE_REGEXP, ['options' => ['regexp' => '/^\d+$/', 'default' => 'none']]));
var_dump(filter_var('日本', FILTER_VALIDATE_REGEXP, ['options' => ['regexp' => '/^\p{Han}+$/u']]));
var_dump(filter_var("\xff", FILTER_VALIDATE_REGEXP, ['options' => ['regexp' => '/./u']]), preg_last_error());
var_dump(filter_var('x', FILTER_VALIDATE_REGEXP, ['options' => ['regexp' => 'bad']]), preg_last_error());
