<?php
$bad = ["a\xffb<", "\xc3", "ok\xe2\x82", "\xed\xa0\x80x", "\xf4\x90\x80\x80", "\xc0\xaf"];
foreach ($bad as $b) {
  echo bin2hex(htmlspecialchars($b)), "|", bin2hex(htmlspecialchars($b, ENT_QUOTES)), "|", bin2hex(htmlspecialchars($b, ENT_QUOTES | ENT_IGNORE)), "|", bin2hex(htmlspecialchars($b, ENT_QUOTES | ENT_SUBSTITUTE)), "\n";
  echo bin2hex(htmlentities($b)), "|", bin2hex(htmlentities($b, ENT_QUOTES)), "|", bin2hex(htmlentities($b, ENT_QUOTES | ENT_IGNORE)), "|", bin2hex(htmlentities($b, ENT_QUOTES | ENT_SUBSTITUTE)), "\n";
}
var_dump(html_entity_decode("&apos;", ENT_QUOTES | ENT_HTML5));
var_dump(html_entity_decode("&apos;", ENT_QUOTES));
var_dump(html_entity_decode("&apos;"));
var_dump(htmlspecialchars_decode("&apos;"));
var_dump(htmlspecialchars_decode("&apos;", ENT_QUOTES | ENT_HTML5));
var_dump(htmlspecialchars_decode("&apos; &#39; &#039; &#x27;", ENT_QUOTES | ENT_XHTML));
var_dump(htmlspecialchars_decode("&apos; &#39; &#039; &#x27;", ENT_QUOTES | ENT_XML1));
var_dump(htmlspecialchars_decode("&#x27; &#X27; &#0000039; &#x22; &#34;"));
var_dump(html_entity_decode("&#0; &#x0; &#00; a"));
var_dump(html_entity_decode("&#1; &#x1F; &#127; &#128; &#x80; &#159;"));
var_dump(html_entity_decode("&#1; &#x1F; &#127; &#128;", ENT_QUOTES | ENT_HTML5));
var_dump(htmlspecialchars("a'b", ENT_QUOTES | ENT_XML1), htmlspecialchars("a'b", ENT_QUOTES | ENT_XHTML), htmlspecialchars("a'b", ENT_QUOTES | ENT_HTML5));
var_dump(htmlentities("é'", ENT_QUOTES | ENT_XML1), htmlentities("é'", ENT_QUOTES | ENT_XHTML));
var_dump(html_entity_decode("&eacute;&hellip;&nbsp;", ENT_QUOTES | ENT_XML1) === "&eacute;&hellip;&nbsp;");
var_dump(html_entity_decode("&lt;&apos;&quot;&amp;&gt;", ENT_QUOTES | ENT_XML1));
var_dump(html_entity_decode("&amp;lt; &AMP; &LT;"));
var_dump(htmlspecialchars("&amp; &foo; &#12; &#xZ;", ENT_QUOTES, null, false));

$references = '&#64975;&#64976;&#65007;&#65008;&#65534;&#65535;&#131070;&#1114111;';
$noncharacters = "\u{FDCF}\u{FDD0}\u{FDEF}\u{FDF0}\u{FFFE}\u{FFFF}\u{1FFFE}\u{10FFFF}";
foreach ([ENT_HTML401, ENT_HTML5, ENT_XML1, ENT_XHTML] as $doctype) {
  echo bin2hex(html_entity_decode($references, $doctype, 'UTF-8')), "\n";
  echo bin2hex(htmlspecialchars($noncharacters, $doctype | ENT_DISALLOWED, 'UTF-8')), "\n";
}
