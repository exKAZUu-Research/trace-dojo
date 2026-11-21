<?php
echo htmlentities("café <b>\"Tom\" & 'Jerry'</b> © 2024 — ½ €"), "\n";
echo htmlentities("a &amp; b", ENT_QUOTES, 'UTF-8', false), " ", htmlentities("日本語"), " ", htmlentities("\"q\"", ENT_NOQUOTES), "\n";
echo html_entity_decode("caf&eacute; &lt;b&gt; &amp;amp; &#65;&#x42; &quot;x&quot; &#039;y&#039; &hellip; &unknown;"), "\n";
echo strip_tags("<p>Hello <b>World</b><br/> <a href=\"x>y\">link</a></p><!-- c -->!"), "\n";
echo strip_tags("<p>Hello <b>World</b> <i>it</i></p>", "<b><i>"), " ", strip_tags("<p>a</p><b>b</b>", ["p"]), "\n";
echo strip_tags("1 < 2 and 3 > 2"), "\n";
