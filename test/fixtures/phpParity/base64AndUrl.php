<?php
foreach (["", "a", "ab", "abc", "abcd", "hello world", "\x00\xff\xfe", str_repeat("xyz", 30)] as $v) echo base64_encode($v), "\n";
foreach (["aGVsbG8=", "aGVsbG8", "aGVs bG8=\n", "aGVsbG8==", "aGVsbG8===", "a", "ab", "abc", "YQ", "YQ=", "Y Q = =", "aGV\$sbG8", "aGVsbG8=x", "=aGVsbG8", "!!!", "", "YW=Jj", "YWJj=", "YWI=Yw=="] as $v) { var_dump(bin2hex((string)base64_decode($v)), base64_decode($v, true) === false ? false : bin2hex(base64_decode($v, true))); }
foreach (["a b&c=d/e?f#g", "~-._*'()!", "日本語", "\x00\x7f\x80\xff", "+%"] as $v) echo urlencode($v), " ", rawurlencode($v), "\n";
foreach (["a+b%20c", "%41%4a%4G%", "%e6%97%a5", "%%41", "100%", "%2"] as $v) echo bin2hex(urldecode($v)), " ", bin2hex(rawurldecode($v)), "\n";
echo str_replace("\r", "<CR>", quoted_printable_encode("Hello = World\r\nCaf\xc3\xa9 \r\n" . str_repeat("x", 100) . " \t\x01\x7f")), "|\n";
echo str_replace("\r", "<CR>", quoted_printable_encode(str_repeat("\xc3\xa9", 40))), "|\n";
echo str_replace("\r", "<CR>", quoted_printable_encode(str_repeat("a", 73) . "\xe6\x97\xa5" . str_repeat("b", 80) . "\xf0\x9f\x98\x80")), "|\n";
foreach (["Caf=C3=A9", "a=\r\nb", "a=  \nb", "a=\nb", "a=x", "a=", "=4", "=4g", "a=\rb", "abc=", "x=  ", "=3D=3d"] as $v) echo bin2hex(quoted_printable_decode($v)), "\n";
foreach (["", "a", "ab", "abc", "abcd", "test\ntext", str_repeat("0123456789", 5), str_repeat("x", 45), str_repeat("y", 46), str_repeat("z", 90), str_repeat("q", 47), "\x00\xff"] as $v) { $e = convert_uuencode($v); echo json_encode($e), " ", bin2hex(convert_uudecode($e)), "\n"; }
var_dump(convert_uudecode(""), convert_uudecode("abc"), convert_uudecode("!"), convert_uudecode("#86)C\n`\n"));
