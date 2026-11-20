<?php
$words = ["Thompson", "Thumb", "knight", "Gnome", "psychology", "wright", "white", "Xavier", "aero", "Ecology", "school", "Christ", "science", "ciao", "cherry", "edge", "dodgy", "laugh", "though", "light", "Bough", "sign", "signed", "gnaw", "agency", "egg", "ghost", "hello", "chat", "back", "phone", "queue", "shoe", "sion", "nation", "the", "match", "vivid", "wow", "box", "yes", "fly", "zoo", "Schwarz", "mb", "lamb", "ACCEPT", "  hello world  ", "123", "", "Wh", "Wa", "W", "a", "ae", "sciatic", "thatch", "Michael", "Science Fiction", "dumb", "muchness", "tight", "ought", "fight", "Hugh", "x-ray", "o'neil"];
foreach ($words as $w) echo $w, " => ", metaphone($w), " | ", metaphone($w, 2), "\n";
try { metaphone("x", -1); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }
var_dump(metaphone("Thompson", 0), metaphone("Thompson", 100), metaphone("a\0b"));
