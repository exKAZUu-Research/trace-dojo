<?php
similar_text("Hello World", "Hallo Welt", $pct); printf("%.4f\n", $pct);
print_r(count_chars("hello", 1)); echo count_chars("hello", 3), "\n";
echo chunk_split("abcdefg", 3, "-"), " ", addslashes("O'Re\"il\\y"), " ", stripslashes("O\\'Re\\\\il"), "\n";
echo substr_replace("Hello", "J", 0, 1), substr_replace("abc", "X", -1), substr_replace("abc", "123", 1, 0), "\n";
print_r(substr_replace(["aaa", "bbb"], "X", 1, 1));
echo strspn("42 apples", "0123456789"), strcspn("abcd", "cd"), "\n";
var_dump(ctype_digit("123"), ctype_digit("12a"), ctype_digit(""), ctype_alpha("abC"), ctype_upper("AB"), ctype_lower("ab1"), ctype_space(" \n"), ctype_alnum("a1"), ctype_punct("!?"), ctype_xdigit("fF0"));
echo mb_strlen("あいうえお"), mb_substr("あいうえお", -2), mb_strpos("あいうえお", "う"), mb_str_pad("あ", 3, "*", STR_PAD_BOTH), mb_strwidth("あaい"), "\n";
echo mb_convert_case("hello world", MB_CASE_TITLE), " ", mb_strtolower("ÀÉÎ"), " ", mb_substr_count("ababab", "ab"), " ", mb_internal_encoding(), "\n";
print_r(mb_str_split("日本語テキスト", 3));
echo ucfirst("hello"), lcfirst("Hello"), ucwords("hello_world-foo", "_-"), "\n";
echo trim("xxhixx", "x"), rtrim("1.5000", "0"), rtrim("abc...", "."), trim("  \t\n x \0"), "|", ltrim("0123", "0..2"), "\n";
echo str_word_count("The quick brown"), " "; print_r(str_word_count("Hello World again", 1)); print_r(str_word_count("Hi there", 2));
echo wordwrap("A very long woooooooooooord.", 8, "\n", true), "\n", wordwrap("A very long woooooooooooord. and something", 8), "\n";
echo strrev("racecar") === "racecar" ? "palindrome" : "no", " ", str_pad(decbin(5), 8, "0", STR_PAD_LEFT), "\n";
echo nl2br("line1\nline2"), " ", htmlspecialchars("a & b < c > \"d\" 'e'"), " ", htmlspecialchars_decode("&lt;p&gt; &amp;amp;"), "\n";
echo strncasecmp("Hello", "hELLO world", 5), strnatcmp("img12", "img10"), strnatcasecmp("A1", "a2"), "\n";
echo implode(",", explode(" ", "a b  c")), " ", implode(",", explode(",", "")), "|", count(explode(",", "")), "\n";
echo sprintf("%'.10d|%-'x10d|%u|%5.2f%%", 42, 42, -1, 99.5), "\n";
echo vsprintf("%2\$s-%1\$s", ["a", "b"]), " ", sprintf("%08.2f", -1.5), " ", sprintf("%+d %+d", 0, -0), "\n";
echo str_contains("", ""), str_starts_with("abc", ""), "|", strpbrk_alt("x"), "\n";
function strpbrk_alt($s) { return strtoupper($s); }
echo bin2hex(hex2bin("48656c6c6f")), " ", strtolower("ÄBC"), " ", sha1(""), "\n";
echo levenshtein("", "abc"), similar_text("", ""), soundex("Tymczak"), soundex(""), "|", ucwords(""), "\n";
echo str_repeat("=", 20), "\n", sprintf("%-15s%10s", "Item", "Price"), "\n", sprintf("%-15s%10.2f", "Coffee", 3.5), "\n";
