<?php
foreach (['ffffffffffffffffffff', '7fffffffffffffff', '8000000000000000', ' 0x1A ', "\t0Xff\n", '0x', 'g1', '1e100', 'ffffffffffffffff'] as $s) {
  var_dump(hexdec($s), base_convert($s, 16, 10), base_convert($s, 16, 2), base_convert($s, 16, 36));
}
var_dump(bindec(str_repeat('1', 70)), octdec('0o777'), octdec('7777777777777777777777777'), bindec('0b101'));
var_dump(intval('0o77', 0), intval('-0o77', 8), intval('+077', 0), intval('0b11', 0), intval('-0xff', 16));
var_dump(intval(" \v\fFF", 16), intval("\xa0FF", 16));
var_dump(base_convert(str_repeat('z', 300), 36, 10));
var_dump(base_convert('-ff', 16, 10), base_convert('', 16, 10), base_convert('FF', 16, 36));
