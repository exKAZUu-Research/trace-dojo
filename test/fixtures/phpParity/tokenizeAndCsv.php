<?php
$tok = strtok("This is\tan example\nstring", " \n\t");
while ($tok !== false) { echo "Word=$tok\n"; $tok = strtok(" \n\t"); }
var_dump(strtok(" "), strtok(" "));
var_dump(strtok("/something", "/"), strtok("/"));
var_dump(strtok("a,,b,", ","), strtok(","), strtok(","), strtok(","));
var_dump(strtok(",,,", ","), strtok(","));
var_dump(strtok("", ","), strtok(","));
var_dump(strtok("abc", ""), strtok(""), strtok(""));
var_dump(strtok("a b", " "), strtok("x"), strtok(" "));
$s = "x"; var_dump(strtok($s, "y"), strtok("y"));
var_dump(str_getcsv('a,b,c', escape: "\\"));
var_dump(str_getcsv('"a","b ""c"" d",e', ',', '"', ''));
var_dump(str_getcsv(' "a" , b ,"c"x,  ,"d', ',', '"', "\\"));
var_dump(str_getcsv("a,b\n", ',', '"', "\\"), str_getcsv("a,b\r\n", ',', '"', "\\"), str_getcsv("", ',', '"', "\\"), str_getcsv("\n", ',', '"', "\\"), str_getcsv(",", ',', '"', "\\"));
var_dump(str_getcsv('"a\"b",c', ',', '"', "\\"), str_getcsv('"a\"b",c', ',', '"', ""), str_getcsv("'x;y';z", ';', "'", "\\"));
var_dump(str_getcsv('"multi
line",x', ',', '"', '\\'), str_getcsv('"unterminated', ',', '"', '\\'), str_getcsv('"unterminated"', ',', '"', '\\'), str_getcsv("\"a\"\n", ',', '"', '\\'), str_getcsv("\"a\n", ',', '"', '\\'));
var_dump(array_map("bin2hex", str_getcsv("é,\"ü\",\xff,x\xff\"y,\"a\xff\"b\xc3\",\"\xc3\xa9\"\xc3\xa9", ",", "\"", "\\")));
var_dump(str_getcsv("a\tb", "\t", '"', "\\"));
var_dump(str_getcsv("a,b"));
try { str_getcsv("a", ",,"); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }
try { str_getcsv("a", ",", ""); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }
try { str_getcsv("a", ",", '"', "ab"); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }
try { str_getcsv("a", "", '"'); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }
var_dump(str_getcsv('"', ',', '"', '\\'), str_getcsv('"\\', ',', '"', '\\'), str_getcsv("\"\n", ',', '"', '\\'), str_getcsv("\"a\"\"", ',', '"', '\\'), str_getcsv("a\r\r\n", ',', '"', '\\'), str_getcsv("  ", ',', '"', '\\'), str_getcsv(" \"x\" y,\"\",\"\"\"\"", ',', '"', '\\'));
var_dump(str_getcsv("\"x\\", ',', '"', '\\'), str_getcsv("x\\\"y", ',', '"', '\\'), str_getcsv("\"\\\"\"", ',', '"', '\\'));
