import { registerSourceModule } from '../sourceModules';

// CPython's `tomllib/_types.py`.
const SOURCE = String.raw`
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2021 Taneli Hukkinen
# Licensed to PSF under a Contributor Agreement.

from typing import Any, Callable, Tuple

# Type annotations
ParseFloat = Callable[[str], Any]
Key = Tuple[str, ...]
Pos = int
`;

registerSourceModule('tomllib._types', SOURCE);
