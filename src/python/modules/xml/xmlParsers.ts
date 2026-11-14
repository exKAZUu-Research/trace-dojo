import { registerModuleAlias } from '../../modules';
import { registerSourceModule } from '../../sourceModules';

// CPython's `xml` package, `xml.parsers`, and `xml.parsers.expat`, whose submodules `model` and `errors` are those of
// `pyexpat`.

const XML = String.raw`"""Core XML support for Python.

This package contains four sub-packages:

dom -- The W3C Document Object Model.  This supports DOM Level 1 +
       Namespaces.

parsers -- Python wrappers for XML parsers (currently only supports Expat).

sax -- The Simple API for XML, developed by XML-Dev, led by David
       Megginson and ported to Python by Lars Marius Garshol.  This
       supports the SAX 2 API.

etree -- The ElementTree XML library.  This is a subset of the full
       ElementTree XML release.

"""


__all__ = ["dom", "parsers", "sax", "etree"]
`;

const PARSERS = String.raw`"""Python interfaces to XML parsers.

This package contains one module:

expat -- Python wrapper for James Clark's Expat parser, with namespace
         support.

"""
`;

const EXPAT = String.raw`"""Interface to the Expat non-validating XML parser."""
import sys

from pyexpat import *

`;

registerSourceModule('xml', XML);
registerSourceModule('xml.parsers', PARSERS);
registerSourceModule('xml.parsers.expat', EXPAT);
registerModuleAlias('xml.parsers.expat.model', 'pyexpat.model');
registerModuleAlias('xml.parsers.expat.errors', 'pyexpat.errors');
