<?php
foreach(["~\u{00a0}~ux","~\u{3000}~ux","~\u{0085}~ux"] as $p){var_dump(preg_match($p,''),preg_match($p,"\u{00a0}\u{3000}\u{0085}"));}
foreach(['~^\R\n$~','~^\R\n$~u','~^\R+$~','~^\R{2}$~','~^\R\R$~'] as $p){foreach(["\r\n","\r\n\n","\r\r\n"] as $s)var_dump(preg_match($p,$s));}
