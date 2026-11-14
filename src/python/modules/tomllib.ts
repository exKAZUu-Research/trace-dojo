import { registerSourceModule } from '../sourceModules';

// CPython's `tomllib/__init__.py`, which imports its submodules by their absolute names.
const SOURCE = String.raw`
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2021 Taneli Hukkinen
# Licensed to PSF under a Contributor Agreement.

__all__ = ("loads", "load", "TOMLDecodeError")

from tomllib._parser import TOMLDecodeError, load, loads

# Pretend this exception was created here.
TOMLDecodeError.__module__ = __name__
`;

registerSourceModule('tomllib', SOURCE);
