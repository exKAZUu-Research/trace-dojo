"""Measure public and protected member names of the modeled libc++ classes."""

import json
import re
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from generateLibcDeclarations import TREE_NODE

CLASSES = {
    "array": "array",
    "deque": "deque",
    "exception": "exception bad_exception",
    "functional": "less greater less_equal greater_equal equal_to not_equal_to plus minus multiplies divides modulus",
    "ios": "ios_base basic_ios:ios",
    "iostream": "basic_istream:istream basic_ostream:ostream basic_iostream:iostream",
    "iterator": "back_insert_iterator reverse_iterator",
    "limits": "numeric_limits",
    "list": "list",
    "map": "map multimap",
    "new": "bad_alloc bad_array_new_length",
    "queue": "queue priority_queue",
    "random": "mersenne_twister_engine:mt19937,mt19937_64 random_device uniform_int_distribution uniform_real_distribution",
    "set": "set multiset",
    "sstream": "basic_istringstream:istringstream basic_ostringstream:ostringstream basic_stringstream:stringstream",
    "stack": "stack",
    "stdexcept": "runtime_error logic_error invalid_argument out_of_range length_error domain_error range_error overflow_error underflow_error",
    "string": "basic_string:string",
    "unordered_map": "unordered_map unordered_multimap",
    "unordered_set": "unordered_set unordered_multiset",
    "utility": "pair",
    "vector": "vector",
}

MEMBER_KINDS = {
    "CXXMethodDecl", "FieldDecl", "FunctionTemplateDecl", "TypeAliasDecl",
    "TypeAliasTemplateDecl", "TypedefDecl", "UsingDecl", "VarDecl",
}


def main():
    version = subprocess.check_output(["clang++", "--version"], text=True)
    if not version.startswith("Apple clang version 21.") or "Target: arm64-apple-" not in version:
        raise SystemExit("Use Apple Clang 21 targeting arm64 macOS.")
    requests = []
    for header, entries in CLASSES.items():
        for entry in entries.split():
            name, _, aliases = entry.partition(":")
            requests.append((header, name, aliases.split(",") if aliases else [name]))
    combined = {}
    with ThreadPoolExecutor(4) as pool:
        for result in pool.map(probe, requests):
            combined.update(result)
    output = Path("src/cpp/library/libcMembers.json")
    output.write_text(json.dumps(combined, sort_keys=True, indent=2) + "\n")
    subprocess.run(["bun", "fmt", "--no-script", "--no-config", str(output)], check=True)


def probe(request):
    header, class_name, keys = request
    dump = subprocess.check_output(
        ["clang++", "-std=c++20", "-x", "c++", "-fsyntax-only", "-Xclang", "-ast-dump",
         "-Xclang", "-ast-dump-filter", "-Xclang", f"std::{class_name}", "-"],
        input=f"#include <{header}>\n", text=True,
    )
    primary, bit_vector = set(), set()
    found_primary = False
    for section in re.split(r"^Dumping ", dump, flags=re.M):
        qualified, _, body = section.partition(":\n")
        if qualified != f"std::{class_name}":
            continue
        for category, syntax, children in records(body):
            record = re.search(rf"\b(class|struct) {class_name} definition\b", syntax)
            if not record:
                continue
            if category == "CXXRecordDecl":
                found_primary = True
                primary.update(members(record[1], children))
            elif class_name == "vector" and ("TemplateArgument", "type 'bool'") in children:
                bit_vector.update(members(record[1], children))
    if not found_primary or (class_name == "vector" and not bit_vector):
        raise ValueError(f"No definition measured for std::{class_name}")
    result = {key: sorted(primary) for key in keys}
    if bit_vector:
        result["vector<bool>"] = sorted(bit_vector)
    return result


def records(body):
    active = None
    for index, line in enumerate(body.splitlines()):
        match = TREE_NODE.match(line)
        if match:
            prefix, category, syntax = match.groups()
            depth = len(prefix) // 2 + 1
        elif index == 0:
            category, _, syntax = line.partition(" ")
            depth = 0
        else:
            continue
        if active and depth <= active[0]:
            yield active[1:]
            active = None
        if active and depth == active[0] + 1:
            active[3].append((category, syntax))
        if not active and depth <= 1 and category in {"CXXRecordDecl", "ClassTemplatePartialSpecializationDecl"}:
            active = (depth, category, syntax, [])
    if active:
        yield active[1:]


def members(tag, children):
    accessible = tag == "struct"
    for category, syntax in children:
        if category == "AccessSpecDecl":
            accessible = not syntax.endswith(" private")
        elif accessible and category in MEMBER_KINDS:
            name = syntax.partition(" '")[0].split()[-1].rsplit("::", 1)[-1]
            if name.isidentifier() and not name.startswith("_"):
                yield name


if __name__ == "__main__":
    main()
