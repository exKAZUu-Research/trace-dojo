<?php
function show($t) { foreach ($t as $k => $v) echo bin2hex($k), "=", $v, " "; echo count($t), "\n"; }
show(get_html_translation_table());
show(get_html_translation_table(HTML_SPECIALCHARS, ENT_NOQUOTES));
show(get_html_translation_table(HTML_SPECIALCHARS, ENT_COMPAT));
show(get_html_translation_table(HTML_SPECIALCHARS, ENT_QUOTES | ENT_HTML5));
show(get_html_translation_table(HTML_SPECIALCHARS, ENT_QUOTES | ENT_XML1));
show(get_html_translation_table(HTML_SPECIALCHARS, ENT_QUOTES | ENT_XHTML));
show(get_html_translation_table(HTML_ENTITIES));
show(get_html_translation_table(HTML_ENTITIES, ENT_QUOTES | ENT_XHTML));
show(get_html_translation_table(HTML_ENTITIES, ENT_QUOTES | ENT_XML1));
show(get_html_translation_table(HTML_ENTITIES, ENT_NOQUOTES, "UTF-8"));
show(get_html_translation_table(5, ENT_COMPAT, "utf-8"));
show(get_html_translation_table(HTML_ENTITIES, ENT_QUOTES, "ISO-8859-1"));
show(get_html_translation_table(HTML_SPECIALCHARS, ENT_QUOTES, ""));
show(get_html_translation_table(HTML_ENTITIES, ENT_QUOTES, "bogus"));
fprintf(STDOUT, "x\n"); vfprintf(STDOUT, "%s-%05.1f\n", ["a", 3.14159]); var_dump(vfprintf(STDERR, "%d\n", [5]));
try { vfprintf(STDOUT, "%s %s", ["a"]); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }
try { vfprintf("x", "%s", ["a"]); } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
