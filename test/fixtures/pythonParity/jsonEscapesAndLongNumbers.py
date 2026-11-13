import json
if json.dumps("😀") != '"\\ud83d\\ude00"' or json.loads(json.dumps({"k😀": "x𝄞"})) != {"k😀": "x𝄞"}:
    raise AssertionError(json.dumps("😀"))
if json.loads("1" * 401) != int("1" * 401) or json.loads("[" + "9" * 500 + "e-490, 1.5]") != [10000000000.0, 1.5]:
    raise AssertionError("long JSON numbers")
try:
    json.loads("1" * 4301)
    raise AssertionError("no digit limit")
except ValueError as error:
    if not str(error).startswith("Exceeds the limit (4300 digits) for integer string conversion: value has 4301 digits"):
        raise
