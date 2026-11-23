<?php
$urls = ["https://user:pass@example.com:8080/path/to/page.php?x=1&y=2#frag", "http://example.com", "http://example.com/", "//example.com/path", "/path/only?q", "path?q#", "?q=1", "#f", "mailto:a@b.com", "example.com:80", "example.com:80/x", "a.com:65536", "a.com:123456", "localhost:", ":80", ":", "http://[::1]:8080/x", "http://[::1]/", "file:///etc/passwd", "file:///c:/dir/file", "file://host/x", "http:///x", "http://:80", "http://a:b@", "http://h:/p", "http://h:abc/p", "http://h:-1/", "http://h:+80/", "ht tp://x", "x:y", "a:65535", "123:456", "http://user@host", "http://u:p:q@h@i/x", "https://example.com?query", "https://example.com#frag?no", "javascript:alert(1)", "news:comp.lang", "urn:isbn:123", "http://example.com:80:90/", "http://ex\x01ample.com/p\x7fa", "", " ", "http://h/p?a#b#c", "//h:99", "//:99", "scheme://", "http:", "1http://x", "http://h?x", "x://h:0/", "a@b:c/d", "http://h:099/", "c:/x", "c:\\x", "foo:/bar", "https://例え.jp/パス"];
foreach ($urls as $u) { echo json_encode($u), " => ", json_encode(parse_url($u)), "\n"; }
var_dump(parse_url("https://u:p@h:1/p?q#f", PHP_URL_SCHEME), parse_url("https://u:p@h:1/p?q#f", PHP_URL_PORT), parse_url("https://h/p", PHP_URL_PORT), parse_url("https://h/p", PHP_URL_QUERY), parse_url("https://u:p@h:1/p?q#f", PHP_URL_FRAGMENT), parse_url("//x", -1), parse_url("http://h:99999", PHP_URL_HOST));
try { parse_url("x", 8); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }
try { parse_url("x", -5); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }
var_dump(parse_url("x", -5));
foreach (["\xe9x://h/p", "x\xe9://h", "http://h\x85x/\x80p?\xadq#\x9f"] as $u) echo bin2hex(json_encode(parse_url($u), JSON_INVALID_UTF8_SUBSTITUTE)), "\n";
setlocale(LC_CTYPE, "C");
foreach (["\xe9x://h/p", "http://h\x85x/\x80p?\xadq#\x9f"] as $u) echo bin2hex(json_encode(parse_url($u), JSON_INVALID_UTF8_SUBSTITUTE)), "\n";
