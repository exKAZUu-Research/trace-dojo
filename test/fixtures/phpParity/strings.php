<?php
$name = "World"; $arr = ['key' => 'val', 3 => 'three']; $obj = new stdClass; $obj->p = 'prop'; $obj->o = new stdClass; $obj->o->q = 'deep';
echo "Hello $name! {$name}s ${name} $arr[key] {$arr['key']} $arr[3] $obj->p {$obj->o->q}\n";
echo 'single $name \n', "\n";
echo "esc: \t|\x41\101\u{1F600}\$name\\ \e[0m|\v|\f|", "\n";
$heredoc = <<<EOT
    Name: $name
      Indented {$arr['key']}
    End
    EOT;
echo $heredoc, "|\n";
$now = <<<'EOT'
Raw $name {$x}
EOT;
echo $now, "\n";
echo strlen("日本語"), mb_strlen("日本語"), mb_substr("日本語テキスト", 2, 3), strtoupper("abc"), mb_strtoupper("äbc"), "\n";
echo str_pad("x", 5, "-", STR_PAD_BOTH), "|", sprintf("%'.10d|%-10s|%u", 42, "left", 3), "\n";
echo ucwords("hello world-foo bar"), " ", ucfirst("élan"), " ", lcfirst("ABC"), "\n";
print_r(explode(",", "a,b,,c")); print_r(explode(",", "a,b,c", 2)); print_r(explode(",", "a,b,c", -1));
print_r(str_split("abcdef", 4)); print_r(mb_str_split("あいう"));
echo implode(", ", ["x", 1, 2.5, true, null]), "\n";
echo trim("  xx  "), "|", rtrim("xx\n"), "|", ltrim("0012", "0"), "|", trim("[abc]", "[]"), "\n";
echo substr("hello", 1, 3), substr("hello", -3), substr("hello", 10), "|", substr("abc", 1, -1), "\n";
var_dump(strpos("hello", "l"), strpos("hello", "z"), strrpos("hello", "l"), stripos("HeLLo", "ll"), str_contains("abc", ""), str_starts_with("abc", "ab"));
echo str_replace(["a", "b"], ["1", "2"], "aabbcc", $count), " $count\n";
echo str_replace("l", "L", "hello"), str_ireplace("L", "x", "Hello"), "\n";
echo ucfirst(strtolower("HELLO")), strrev("abc"), str_repeat("=", 5), "\n";
echo nl2br("a\nb"), htmlspecialchars("<a href='x'>T&C</a>"), "\n";
echo number_format(1234567.891), " ", number_format(1234567.891, 2), " ", number_format(0.125, 2), "\n";
echo sprintf("%08.3f", 3.14159), sprintf("[%5s][%-5s]", "ab", "ab"), sprintf("%03d", 7), sprintf("%x %o %b %X %e", 255, 8, 5, 255, 1234.5), "\n";
echo strcmp("a", "b"), strcmp("b", "a"), strcmp("a", "a"), strcasecmp("HELLO", "hello"), strncmp("abcd", "abcf", 3), "\n";
echo wordwrap("The quick brown fox sat over the lazy dog", 15, "\n", true), "\n";
echo similar_text("World", "Word"), levenshtein("kitten", "sitting"), soundex("Robert"), "\n";
echo md5("hello"), " ", sha1("abc"), " ", crc32("The quick brown fox jumped over the lazy dog."), "\n";
echo str_word_count("Hello fri3nd, you're looking good today!"), " ", ucwords(strtolower("JOHN O'REILLY")), "\n";
echo chr(65), ord("a"), dechex(255), hexdec("ff"), bindec("1010"), decbin(10), octdec("17"), base_convert("ff", 16, 2), "\n";
echo strstr("user@example.com", "@"), strstr("user@example.com", "@", true), strrchr("a/b/c", "/"), "\n";
echo substr_count("hello hello", "ll"), ucfirst(""), "|", strtr("Hi all", "ai", "eo"), strtr("Hi all", ["Hi" => "Hello", "all" => "world"]), "\n";
var_dump("abc" == "ABC", "10" == "1e1", 100 == "1e2", "abc" <=> "abd");
echo sprintf("%s", 1.0), " ", 1.0, " ", 2.50, " ", 1e3, " ", 0.1 + 0.2, " ", 1/3, "\n";
echo intval("42abc"), (int)"  42", floatval("1.5e3abc"), "\n";
echo str_contains("Hello", "ell") ? "yes" : "no", "\n";
$s = "abc"; echo $s[0], "\n";
