"""The encoding the generated Unicode tables share: runs of code points and their printing as Prettier formats it."""
import sys


def runs(test):
    """The code points that pass the test, as runs of "gap,length" in hexadecimal from the previous run's end."""
    result = []
    end = 0
    code = 0
    while code <= sys.maxunicode:
        if not test(chr(code)):
            code += 1
            continue
        start = code
        while code <= sys.maxunicode and test(chr(code)):
            code += 1
        result.append(f'{start - end:x},{code - start:x}')
        end = code
    return ';'.join(result)


def print_property(name, value):
    """Prints a property as Prettier formats it: on one line when that fits in 120 columns."""
    line = f"  {name}: '{value}',"
    print(line if len(line) <= 120 else f"  {name}:\n    '{value}',")
