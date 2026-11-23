<?php
echo http_build_query(['a' => 1, 'b' => 'x y', 'c' => true, 'd' => false, 'e' => null, 'f' => 1.5, 'g' => 0.1 + 0.2, 'h' => 1e20, 'i' => -0.0]), "\n";
echo http_build_query([1, 2, 'x' => [3, 4, 'k' => ['z' => 5]], 'emp' => []]), "\n";
echo http_build_query([1, 2, 'x' => [3, 'y' => [6]]], 'n_'), "\n";
echo http_build_query(['a b' => 'c~d', 'é' => 'ü'], '', '&amp;'), "\n";
echo http_build_query(['a b' => 'c~d e', 'k' => ['x y' => 1]], '', null, PHP_QUERY_RFC3986), "\n";
echo http_build_query(['a' => 1, 'b' => 2], '', ''), "\n";
class P { public $pub = 1; protected $pro = 2; private $pri = 3; public $arr = [1, 2]; public $nul = null; public function q() { return http_build_query($this); } }
$p = new P; $p->dyn = 'd';
echo http_build_query($p), "\n", $p->q(), "\n";
echo http_build_query(['o' => $p, 'n' => new stdClass]), "\n";
$r = [1]; $r[] = &$r; echo http_build_query($r), "\n";
echo http_build_query([]), "|\n";
echo http_build_query(['a' => [null, [null]]]), "|\n";
parse_str("a=1&b[]=2&b[]=3&c[x]=4&c[y][z]=5&d=%20x+y&e&f=&g[=7&h]=8&i.j=9&k l=10& m=11&n[ x]=12&n[]=13&o[a][b]c=14&p[a]x[b]=15&q=1&q=2&r[1]=a&r[]=b&r[01]=c&0=zero&=empty&%61%5Bb%5D=enc&s[[x]=s&t[]]=t", $out);
var_dump($out);
parse_str("", $o2); var_dump($o2);
parse_str("a=1&&&b=2&", $o3); var_dump($o3);
parse_str("x=1\0y=2&z=3", $o4); var_dump($o4);
parse_str("x%00y=1&v=a%00b", $o5); var_dump(bin2hex($o5['v']), array_keys($o5));
parse_str("a[b]=1&a=2&a[c]=3", $o6); var_dump($o6);
parse_str(str_repeat("[a]", 3) . "=1", $o7); var_dump($o7);
parse_str("a" . str_repeat("[a]", 70) . "=1&b=2", $o8); var_dump($o8);
