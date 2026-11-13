# @dataclass reads annotations as FORWARDREF: an undefined name becomes a forward reference instead of raising.
import dataclasses
import typing


@dataclasses.dataclass
class Node:
    value: int
    next: Node = None


@dataclasses.dataclass
class D:
    x: Undefined = 1
    y: list[Undefined] = None


@dataclasses.dataclass
class C:
    a: int
    cv: dataclasses.ClassVar = 5


@dataclasses.dataclass
class E:
    a: int
    cv: typing.ClassVar[int] = 5
    n: Later = 0
    s: 'Quoted' = 1


got = [repr(Node(1, Node(2))), [f.name for f in dataclasses.fields(Node)], [repr(f.type) for f in dataclasses.fields(Node)], repr(D()), [repr(f.type) for f in dataclasses.fields(D)], repr(C(1)), [repr(f.type) for f in dataclasses.fields(C)], repr(E(1)), [f.name for f in dataclasses.fields(E)], dataclasses.fields(E)[2].type]
try:
    D.__annotations__
except NameError as error:
    got.append(str(error))
expected = ['Node(value=1, next=Node(value=2, next=None))', ['value', 'next'], ["<class 'int'>", "ForwardRef('Node', is_class=True, owner=<class '__main__.Node'>)"], 'D(x=1, y=None)', ["ForwardRef('Undefined', is_class=True, owner=<class '__main__.D'>)", "list[ForwardRef('Undefined', is_class=True, owner=<class '__main__.D'>)]"], 'C(a=1, cv=5)', ["<class 'int'>", "ForwardRef('dataclasses.ClassVar', is_class=True, owner=<class '__main__.C'>)"], 'E(a=1, n=0, s=1)', ['a', 'n', 's'], 'Quoted', "name 'Undefined' is not defined"]
if got != expected:
    raise AssertionError(got)
