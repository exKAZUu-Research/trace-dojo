<?php
$src = "ｱｲｳｴｵ ｶﾞｷﾞｸﾞ ﾊﾟﾋﾟﾌﾟ ｳﾞ ｰ｡｢｣､･ﾞﾟ ABC abc 123 !\"#'\\~ ＡＢＣ ａｂｃ １２３ ！＂＃＇＼～ アイウ ガギグ パピプ ヴ ぁあぃいゔ がぎ ぱぴ　、。「」゛゜ー・ ¥ ‾ ‘’“” ￥ ￣ − ゝゞヽヾ ヵヶ ゎゐゑ ヮヰヱヲン";
foreach (["", "KV", "K", "H", "HV", "r", "R", "n", "N", "a", "A", "s", "S", "k", "h", "c", "C", "M", "m", "KVas", "AS", "as", "RNSKV", "rnsk", "rnsh", "Hc", "hm", "kM", "KVC", "V", "Ah"] as $m) {
  echo $m, ": ", mb_convert_kana($src, $m), "\n";
}
echo mb_convert_kana($src), "\n";
echo mb_convert_kana("ｶﾞ", "K"), mb_convert_kana("ｶ", "KV"), mb_convert_kana("ﾞ", "KV"), mb_convert_kana("ｳﾞ", "HV"), mb_convert_kana("ﾊﾟ", "HV"), "\n";
echo bin2hex(mb_convert_kana("ｱ\x80ｲ", "KV")), " ", bin2hex(mb_convert_kana("ｱｲ", "KV", "UTF-16")), "\n";
foreach (["x", "Aa", "Rr", "Nn", "Ss", "Kk", "Hh", "Mm", "Cc", "Ar", "Ra", "HK", "hC", "hc", "kC", "kc", "Ra", "rA", "AR"] as $m) { try { mb_convert_kana("a", $m); echo "$m ok\n"; } catch (ValueError $e) { echo $e->getMessage(), "\n"; } }
