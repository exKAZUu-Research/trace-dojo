"""Measure public and protected member names of the modeled libc++ classes."""

import json
import re
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from generateLibcDeclarations import TREE_NODE

CLASSES = {
    "array": "array",
    "deque": "deque __deque_iterator",
    "exception": "exception bad_exception",
    "functional": "less greater less_equal greater_equal equal_to not_equal_to plus minus multiplies divides modulus",
    "ios": "ios_base basic_ios:ios",
    "iostream": "basic_istream:istream basic_ostream:ostream basic_iostream:iostream",
    "iterator": "back_insert_iterator reverse_iterator",
    "limits": "numeric_limits",
    "list": "list __list_iterator __list_const_iterator",
    "map": "map multimap __map_iterator __map_const_iterator",
    "new": "bad_alloc bad_array_new_length",
    "queue": "queue priority_queue",
    "random": "mersenne_twister_engine:mt19937,mt19937_64 random_device uniform_int_distribution uniform_real_distribution",
    "set": "set multiset __tree_const_iterator",
    "sstream": "basic_istringstream:istringstream basic_ostringstream:ostringstream basic_stringstream:stringstream",
    "stack": "stack",
    "stdexcept": "runtime_error logic_error invalid_argument out_of_range length_error domain_error range_error overflow_error underflow_error",
    "string": "basic_string:string",
    "unordered_map": "unordered_map unordered_multimap __hash_map_iterator __hash_map_const_iterator",
    "unordered_set": "unordered_set unordered_multiset __hash_const_iterator",
    "utility": "pair",
    "vector": "vector __wrap_iter __bit_iterator __bit_reference __bit_const_reference",
}

MEMBER_KINDS = {
    "CXXMethodDecl", "CXXRecordDecl", "ClassTemplateDecl", "EnumDecl", "FieldDecl",
    "FunctionTemplateDecl", "TypeAliasDecl", "TypeAliasTemplateDecl", "TypedefDecl",
    "UsingDecl", "VarDecl",
}

VARIANT_ARGUMENTS = {"vector": "bool", **dict.fromkeys(CLASSES["functional"].split(), "void")}


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
    primary, specialized = set(), set()
    found_primary = False
    variant = VARIANT_ARGUMENTS.get(class_name)
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
            elif variant and (1, "TemplateArgument", f"type '{variant}'") in children:
                specialized.update(members(record[1], children))
    if not found_primary or (variant and not specialized):
        raise ValueError(f"No definition measured for std::{class_name}")
    result = {key: sorted(primary) for key in keys}
    if specialized:
        result[f"{class_name}<{variant}>"] = sorted(specialized)
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
        if active and (depth == active[0] + 1 or depth == active[0] + 2 and category == "EnumConstantDecl"):
            active[3].append((depth - active[0], category, syntax))
        if not active and depth <= 1 and category in {
            "CXXRecordDecl", "ClassTemplatePartialSpecializationDecl", "ClassTemplateSpecializationDecl",
        }:
            active = (depth, category, syntax, [])
    if active:
        yield active[1:]


def members(tag, children):
    accessible = tag == "struct"
    unscoped_enum = False
    for depth, category, syntax in children:
        head = syntax.partition(" '")[0]
        if depth == 1:
            unscoped_enum = category == "EnumDecl" and not re.search(r"\b(class|struct)\s+\w+$", head)
        if category == "AccessSpecDecl":
            accessible = not syntax.endswith(" private")
        elif accessible and (category in MEMBER_KINDS or unscoped_enum and category == "EnumConstantDecl"):
            name = member_name(category, head)
            if name and name.isidentifier() and not name.startswith("_"):
                yield name


def member_name(category, head):
    if category == "CXXRecordDecl":
        if " implicit " in head:
            return None
        record = re.search(r"\b(?:class|struct|union) (\w+)(?: definition)?$", head)
        return record[1] if record else None
    return head.split()[-1].rsplit("::", 1)[-1]


if __name__ == "__main__":
    main()
