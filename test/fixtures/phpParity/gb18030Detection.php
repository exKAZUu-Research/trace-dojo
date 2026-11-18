<?php
foreach (['GB18030', 'GB18030-2022'] as $variant) {
    var_dump(mb_detect_encoding("\x80", ['UTF-8', $variant, 'SJIS']));
    var_dump(mb_detect_encoding("a\x80b", ['UTF-8', $variant], true));
    var_dump(mb_detect_encoding("\x80", [$variant, 'CP936']));
    var_dump(mb_detect_encoding("\x81\x80", [$variant], true));
    var_dump(mb_detect_encoding("\x81\x30\x81\x30", [$variant], true));
    var_dump(mb_detect_encoding("\x90\x30\x81\x30", [$variant], true));
    var_dump(mb_detect_encoding("\x85\x30\x81\x30", [$variant], true));
    var_dump(mb_detect_encoding("\x81\x30\x80\x30", [$variant], true));
}
foreach (['EUC-CN', 'GB2312'] as $variant) {
    var_dump(mb_detect_encoding("\x80", ['UTF-8', $variant, 'SJIS']));
    var_dump(mb_detect_encoding("a\x80b", ['UTF-8', $variant], true));
    var_dump(mb_detect_encoding("\x80", [$variant, 'CP936']));
    var_dump(mb_detect_encoding("\xd6\xd0", [$variant], true));
    var_dump(mb_detect_encoding("\xd6\x80", [$variant], true));
    var_dump(mb_detect_encoding("\xa6\xd9", [$variant], true));
}
