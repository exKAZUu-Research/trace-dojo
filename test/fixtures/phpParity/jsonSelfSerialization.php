<?php
class JsonSelf implements JsonSerializable {public $x=1;function jsonSerialize():mixed{return $this;}}
var_dump(json_encode(new JsonSelf),json_last_error(),json_encode([new JsonSelf],JSON_PRETTY_PRINT));
$a=new JsonSelf;$a->x=$a;var_dump(json_encode($a),json_last_error(),json_encode([$a],JSON_PARTIAL_OUTPUT_ON_ERROR));
class JsonOther implements JsonSerializable{public $other;function jsonSerialize():mixed{return $this->other;}}
$a=new JsonOther;$b=new JsonOther;$a->other=$b;$b->other=$a;var_dump(json_encode($a),json_last_error());
class JsonMutator implements JsonSerializable {public $f;function jsonSerialize():mixed{($this->f)();return 1;}}
$m=new JsonMutator;$items=[$m,2];$m->f=function()use(&$items){$items[]=3;$items[1]=4;};var_dump(json_encode($items),count($items),$items[1]);
