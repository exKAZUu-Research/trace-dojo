import { TOK } from './expatTokenizer';

// A transcription of expat's xmlrole.c for the document entity: the state machine that gives each token of the prolog
// and of the internal DTD subset its role.

export type Role =
  | 'ERROR'
  | 'NONE'
  | 'XML_DECL'
  | 'INSTANCE_START'
  | 'DOCTYPE_NONE'
  | 'DOCTYPE_NAME'
  | 'DOCTYPE_SYSTEM_ID'
  | 'DOCTYPE_PUBLIC_ID'
  | 'DOCTYPE_INTERNAL_SUBSET'
  | 'DOCTYPE_CLOSE'
  | 'GENERAL_ENTITY_NAME'
  | 'PARAM_ENTITY_NAME'
  | 'ENTITY_NONE'
  | 'ENTITY_VALUE'
  | 'ENTITY_SYSTEM_ID'
  | 'ENTITY_PUBLIC_ID'
  | 'ENTITY_COMPLETE'
  | 'ENTITY_NOTATION_NAME'
  | 'NOTATION_NONE'
  | 'NOTATION_NAME'
  | 'NOTATION_SYSTEM_ID'
  | 'NOTATION_NO_SYSTEM_ID'
  | 'NOTATION_PUBLIC_ID'
  | 'ATTRIBUTE_NAME'
  | 'ATTRIBUTE_TYPE'
  | 'ATTRIBUTE_ENUM_VALUE'
  | 'ATTRIBUTE_NOTATION_VALUE'
  | 'ATTLIST_NONE'
  | 'ATTLIST_ELEMENT_NAME'
  | 'IMPLIED_ATTRIBUTE_VALUE'
  | 'REQUIRED_ATTRIBUTE_VALUE'
  | 'DEFAULT_ATTRIBUTE_VALUE'
  | 'FIXED_ATTRIBUTE_VALUE'
  | 'ELEMENT_NONE'
  | 'ELEMENT_NAME'
  | 'CONTENT_ANY'
  | 'CONTENT_EMPTY'
  | 'CONTENT_PCDATA'
  | 'GROUP_OPEN'
  | 'GROUP_CLOSE'
  | 'GROUP_CLOSE_REP'
  | 'GROUP_CLOSE_OPT'
  | 'GROUP_CLOSE_PLUS'
  | 'GROUP_CHOICE'
  | 'GROUP_SEQUENCE'
  | 'CONTENT_ELEMENT'
  | 'CONTENT_ELEMENT_REP'
  | 'CONTENT_ELEMENT_OPT'
  | 'CONTENT_ELEMENT_PLUS'
  | 'PI'
  | 'COMMENT'
  | 'PARAM_ENTITY_REF';

type Handler = (state: PrologState, token: number, text: string) => Role;

/** The attribute types an ATTLIST may name, which the type role carries as its text. */
export const ATTRIBUTE_TYPES = new Set(['CDATA', 'ID', 'IDREF', 'IDREFS', 'ENTITY', 'ENTITIES', 'NMTOKEN', 'NMTOKENS']);

export class PrologState {
  handler: Handler = prolog0;
  level = 0;
  roleNone: Role = 'NONE';

  /** The role of a token, whose text a keyword is compared with. */
  role(token: number, text: string): Role {
    return this.handler(this, token, text);
  }
}

function common(state: PrologState): Role {
  state.handler = error;
  return 'ERROR';
}

function error(): Role {
  return 'NONE';
}

function prolog0(state: PrologState, token: number, text: string): Role {
  switch (token) {
    case TOK.PROLOG_S: {
      state.handler = prolog1;
      return 'NONE';
    }
    case TOK.XML_DECL: {
      state.handler = prolog1;
      return 'XML_DECL';
    }
    case TOK.BOM: {
      return 'NONE';
    }
    default: {
      return prolog1(state, token, text);
    }
  }
}

function prolog1(state: PrologState, token: number, text: string): Role {
  switch (token) {
    case TOK.PROLOG_S:
    case TOK.BOM: {
      return 'NONE';
    }
    case TOK.PI: {
      state.handler = prolog1;
      return 'PI';
    }
    case TOK.COMMENT: {
      state.handler = prolog1;
      return 'COMMENT';
    }
    case TOK.DECL_OPEN: {
      if (text !== '<!DOCTYPE') break;
      state.handler = doctype0;
      return 'DOCTYPE_NONE';
    }
    case TOK.INSTANCE_START: {
      state.handler = error;
      return 'INSTANCE_START';
    }
  }
  return common(state);
}

function prolog2(state: PrologState, token: number): Role {
  switch (token) {
    case TOK.PROLOG_S: {
      return 'NONE';
    }
    case TOK.PI: {
      return 'PI';
    }
    case TOK.COMMENT: {
      return 'COMMENT';
    }
    case TOK.INSTANCE_START: {
      state.handler = error;
      return 'INSTANCE_START';
    }
  }
  return common(state);
}

/** A state that moves to `next` with `role` on one token, and returns `none` on spaces. */
function step(
  none: Role,
  transitions: Partial<Record<number, [Handler, Role] | ((state: PrologState, text: string) => Role | undefined)>>
): Handler {
  return (state, token, text) => {
    if (token === TOK.PROLOG_S) return none;
    const transition = transitions[token];
    if (typeof transition === 'function') {
      const role = transition(state, text);
      if (role !== undefined) return role;
    } else if (transition) {
      state.handler = transition[0];
      return transition[1];
    }
    return common(state);
  };
}

/** A keyword transition: to `next` with `role` when the token's text is one of the keywords. */
function keywords(table: Record<string, [Handler, Role]>): (state: PrologState, text: string) => Role | undefined {
  return (state, text) => {
    const target = table[text];
    if (!target) return;
    state.handler = target[0];
    return target[1];
  };
}

function setTopLevel(state: PrologState): void {
  state.handler = internalSubset;
}

function declClose(state: PrologState, token: number): Role {
  if (token === TOK.PROLOG_S) return state.roleNone;
  if (token === TOK.DECL_CLOSE) {
    setTopLevel(state);
    return state.roleNone;
  }
  return common(state);
}

function toDeclClose(none: Role, role: Role): (state: PrologState) => Role {
  return (state) => {
    state.handler = declClose;
    state.roleNone = none;
    return role;
  };
}

function toTopLevel(role: Role): (state: PrologState) => Role {
  return (state) => {
    setTopLevel(state);
    return role;
  };
}

// DOCTYPE -------------------------------------------------------------------------------------------------------------

const doctype5: Handler = step('DOCTYPE_NONE', { [TOK.DECL_CLOSE]: [prolog2, 'DOCTYPE_CLOSE'] });

function internalSubset(state: PrologState, token: number, text: string): Role {
  switch (token) {
    case TOK.PROLOG_S:
    case TOK.NONE: {
      return 'NONE';
    }
    case TOK.DECL_OPEN: {
      const declarations: Record<string, [Handler, Role]> = {
        '<!ENTITY': [entity0, 'ENTITY_NONE'],
        '<!ATTLIST': [attlist0, 'ATTLIST_NONE'],
        '<!ELEMENT': [element0, 'ELEMENT_NONE'],
        '<!NOTATION': [notation0, 'NOTATION_NONE'],
      };
      const target = declarations[text];
      if (!target) break;
      state.handler = target[0];
      return target[1];
    }
    case TOK.PI: {
      return 'PI';
    }
    case TOK.COMMENT: {
      return 'COMMENT';
    }
    case TOK.PARAM_ENTITY_REF: {
      return 'PARAM_ENTITY_REF';
    }
    case TOK.CLOSE_BRACKET: {
      state.handler = doctype5;
      return 'DOCTYPE_NONE';
    }
  }
  return common(state);
}

const doctype4: Handler = step('DOCTYPE_NONE', {
  [TOK.OPEN_BRACKET]: [internalSubset, 'DOCTYPE_INTERNAL_SUBSET'],
  [TOK.DECL_CLOSE]: [prolog2, 'DOCTYPE_CLOSE'],
});
const doctype3: Handler = step('DOCTYPE_NONE', { [TOK.LITERAL]: [doctype4, 'DOCTYPE_SYSTEM_ID'] });
const doctype2: Handler = step('DOCTYPE_NONE', { [TOK.LITERAL]: [doctype3, 'DOCTYPE_PUBLIC_ID'] });
const doctype1: Handler = step('DOCTYPE_NONE', {
  [TOK.OPEN_BRACKET]: [internalSubset, 'DOCTYPE_INTERNAL_SUBSET'],
  [TOK.DECL_CLOSE]: [prolog2, 'DOCTYPE_CLOSE'],
  [TOK.NAME]: keywords({ SYSTEM: [doctype3, 'DOCTYPE_NONE'], PUBLIC: [doctype2, 'DOCTYPE_NONE'] }),
});
const doctype0: Handler = step('DOCTYPE_NONE', {
  [TOK.NAME]: [doctype1, 'DOCTYPE_NAME'],
  [TOK.PREFIXED_NAME]: [doctype1, 'DOCTYPE_NAME'],
});

// ENTITY --------------------------------------------------------------------------------------------------------------

const entity10: Handler = step('ENTITY_NONE', { [TOK.DECL_CLOSE]: toTopLevel('ENTITY_COMPLETE') });
const entity9: Handler = step('ENTITY_NONE', { [TOK.LITERAL]: [entity10, 'ENTITY_SYSTEM_ID'] });
const entity8: Handler = step('ENTITY_NONE', { [TOK.LITERAL]: [entity9, 'ENTITY_PUBLIC_ID'] });
const entity7: Handler = step('ENTITY_NONE', {
  [TOK.NAME]: keywords({ SYSTEM: [entity9, 'ENTITY_NONE'], PUBLIC: [entity8, 'ENTITY_NONE'] }),
  [TOK.LITERAL]: toDeclClose('ENTITY_NONE', 'ENTITY_VALUE'),
});
const entity6: Handler = step('ENTITY_NONE', { [TOK.NAME]: toDeclClose('ENTITY_NONE', 'ENTITY_NOTATION_NAME') });
const entity5: Handler = step('ENTITY_NONE', {
  [TOK.DECL_CLOSE]: toTopLevel('ENTITY_COMPLETE'),
  [TOK.NAME]: keywords({ NDATA: [entity6, 'ENTITY_NONE'] }),
});
const entity4: Handler = step('ENTITY_NONE', { [TOK.LITERAL]: [entity5, 'ENTITY_SYSTEM_ID'] });
const entity3: Handler = step('ENTITY_NONE', { [TOK.LITERAL]: [entity4, 'ENTITY_PUBLIC_ID'] });
const entity2: Handler = step('ENTITY_NONE', {
  [TOK.NAME]: keywords({ SYSTEM: [entity4, 'ENTITY_NONE'], PUBLIC: [entity3, 'ENTITY_NONE'] }),
  [TOK.LITERAL]: toDeclClose('ENTITY_NONE', 'ENTITY_VALUE'),
});
const entity1: Handler = step('ENTITY_NONE', { [TOK.NAME]: [entity7, 'PARAM_ENTITY_NAME'] });
const entity0: Handler = step('ENTITY_NONE', {
  [TOK.PERCENT]: [entity1, 'ENTITY_NONE'],
  [TOK.NAME]: [entity2, 'GENERAL_ENTITY_NAME'],
});

// NOTATION ------------------------------------------------------------------------------------------------------------

const notation4: Handler = step('NOTATION_NONE', {
  [TOK.LITERAL]: toDeclClose('NOTATION_NONE', 'NOTATION_SYSTEM_ID'),
  [TOK.DECL_CLOSE]: toTopLevel('NOTATION_NO_SYSTEM_ID'),
});
const notation3: Handler = step('NOTATION_NONE', {
  [TOK.LITERAL]: toDeclClose('NOTATION_NONE', 'NOTATION_SYSTEM_ID'),
});
const notation2: Handler = step('NOTATION_NONE', { [TOK.LITERAL]: [notation4, 'NOTATION_PUBLIC_ID'] });
const notation1: Handler = step('NOTATION_NONE', {
  [TOK.NAME]: keywords({ SYSTEM: [notation3, 'NOTATION_NONE'], PUBLIC: [notation2, 'NOTATION_NONE'] }),
});
const notation0: Handler = step('NOTATION_NONE', { [TOK.NAME]: [notation1, 'NOTATION_NAME'] });

// ATTLIST -------------------------------------------------------------------------------------------------------------

const attlist9: Handler = step('ATTLIST_NONE', {
  [TOK.LITERAL]: (state) => {
    state.handler = attlist1;
    return 'FIXED_ATTRIBUTE_VALUE';
  },
});
const attlist8: Handler = step('ATTLIST_NONE', {
  [TOK.POUND_NAME]: (state, text) => {
    const target: Record<string, [Handler, Role]> = {
      '#IMPLIED': [attlist1, 'IMPLIED_ATTRIBUTE_VALUE'],
      '#REQUIRED': [attlist1, 'REQUIRED_ATTRIBUTE_VALUE'],
      '#FIXED': [attlist9, 'ATTLIST_NONE'],
    };
    return keywords(target)(state, text);
  },
  [TOK.LITERAL]: (state) => {
    state.handler = attlist1;
    return 'DEFAULT_ATTRIBUTE_VALUE';
  },
});
const attlist7: Handler = step('ATTLIST_NONE', {
  [TOK.CLOSE_PAREN]: (state) => {
    state.handler = attlist8;
    return 'ATTLIST_NONE';
  },
  [TOK.OR]: (state) => {
    state.handler = attlist6;
    return 'ATTLIST_NONE';
  },
});
const attlist6: Handler = step('ATTLIST_NONE', { [TOK.NAME]: [attlist7, 'ATTRIBUTE_NOTATION_VALUE'] });
const attlist5: Handler = step('ATTLIST_NONE', { [TOK.OPEN_PAREN]: [attlist6, 'ATTLIST_NONE'] });
const attlist4: Handler = step('ATTLIST_NONE', {
  [TOK.CLOSE_PAREN]: (state) => {
    state.handler = attlist8;
    return 'ATTLIST_NONE';
  },
  [TOK.OR]: (state) => {
    state.handler = attlist3;
    return 'ATTLIST_NONE';
  },
});
const attlist3: Handler = step('ATTLIST_NONE', {
  [TOK.NMTOKEN]: [attlist4, 'ATTRIBUTE_ENUM_VALUE'],
  [TOK.NAME]: [attlist4, 'ATTRIBUTE_ENUM_VALUE'],
  [TOK.PREFIXED_NAME]: [attlist4, 'ATTRIBUTE_ENUM_VALUE'],
});
const attlist2: Handler = step('ATTLIST_NONE', {
  [TOK.NAME]: (state, text) => {
    if (ATTRIBUTE_TYPES.has(text)) {
      state.handler = attlist8;
      return 'ATTRIBUTE_TYPE';
    }
    if (text !== 'NOTATION') return;
    state.handler = attlist5;
    return 'ATTLIST_NONE';
  },
  [TOK.OPEN_PAREN]: (state) => {
    state.handler = attlist3;
    return 'ATTLIST_NONE';
  },
});
function attlist1(state: PrologState, token: number, text: string): Role {
  return step('ATTLIST_NONE', {
    [TOK.DECL_CLOSE]: toTopLevel('ATTLIST_NONE'),
    [TOK.NAME]: [attlist2, 'ATTRIBUTE_NAME'],
    [TOK.PREFIXED_NAME]: [attlist2, 'ATTRIBUTE_NAME'],
  })(state, token, text);
}
const attlist0: Handler = step('ATTLIST_NONE', {
  [TOK.NAME]: [attlist1, 'ATTLIST_ELEMENT_NAME'],
  [TOK.PREFIXED_NAME]: [attlist1, 'ATTLIST_ELEMENT_NAME'],
});

// ELEMENT -------------------------------------------------------------------------------------------------------------

/** The roles of a content particle: a name, optionally followed by `?`, `*`, or `+`. */
function particles(next: () => Handler): Partial<Record<number, (state: PrologState) => Role>> {
  const to =
    (role: Role) =>
    (state: PrologState): Role => {
      state.handler = next();
      return role;
    };
  return {
    [TOK.NAME]: to('CONTENT_ELEMENT'),
    [TOK.PREFIXED_NAME]: to('CONTENT_ELEMENT'),
    [TOK.NAME_QUESTION]: to('CONTENT_ELEMENT_OPT'),
    [TOK.NAME_ASTERISK]: to('CONTENT_ELEMENT_REP'),
    [TOK.NAME_PLUS]: to('CONTENT_ELEMENT_PLUS'),
  };
}

function closeGroup(role: Role): (state: PrologState) => Role {
  return (state) => {
    state.level -= 1;
    if (state.level === 0) {
      state.handler = declClose;
      state.roleNone = 'ELEMENT_NONE';
    }
    return role;
  };
}

function element7(state: PrologState, token: number, text: string): Role {
  return step('ELEMENT_NONE', {
    [TOK.CLOSE_PAREN]: closeGroup('GROUP_CLOSE'),
    [TOK.CLOSE_PAREN_ASTERISK]: closeGroup('GROUP_CLOSE_REP'),
    [TOK.CLOSE_PAREN_QUESTION]: closeGroup('GROUP_CLOSE_OPT'),
    [TOK.CLOSE_PAREN_PLUS]: closeGroup('GROUP_CLOSE_PLUS'),
    [TOK.COMMA]: [element6, 'GROUP_SEQUENCE'],
    [TOK.OR]: [element6, 'GROUP_CHOICE'],
  })(state, token, text);
}
function element6(state: PrologState, token: number, text: string): Role {
  return step('ELEMENT_NONE', {
    [TOK.OPEN_PAREN]: (current) => {
      current.level += 1;
      return 'GROUP_OPEN';
    },
    ...particles(() => element7),
  })(state, token, text);
}
function element5(state: PrologState, token: number, text: string): Role {
  return step('ELEMENT_NONE', {
    [TOK.CLOSE_PAREN_ASTERISK]: toDeclClose('ELEMENT_NONE', 'GROUP_CLOSE_REP'),
    [TOK.OR]: [element4, 'ELEMENT_NONE'],
  })(state, token, text);
}
const element4: Handler = step('ELEMENT_NONE', {
  [TOK.NAME]: [element5, 'CONTENT_ELEMENT'],
  [TOK.PREFIXED_NAME]: [element5, 'CONTENT_ELEMENT'],
});
const element3: Handler = step('ELEMENT_NONE', {
  [TOK.CLOSE_PAREN]: toDeclClose('ELEMENT_NONE', 'GROUP_CLOSE'),
  [TOK.CLOSE_PAREN_ASTERISK]: toDeclClose('ELEMENT_NONE', 'GROUP_CLOSE_REP'),
  [TOK.OR]: [element4, 'ELEMENT_NONE'],
});
const element2: Handler = step('ELEMENT_NONE', {
  [TOK.POUND_NAME]: keywords({ '#PCDATA': [element3, 'CONTENT_PCDATA'] }),
  [TOK.OPEN_PAREN]: (state) => {
    state.level = 2;
    state.handler = element6;
    return 'GROUP_OPEN';
  },
  ...particles(() => element7),
});
const element1: Handler = step('ELEMENT_NONE', {
  [TOK.NAME]: (state, text) => {
    if (text === 'EMPTY') return toDeclClose('ELEMENT_NONE', 'CONTENT_EMPTY')(state);
    if (text === 'ANY') return toDeclClose('ELEMENT_NONE', 'CONTENT_ANY')(state);
    return;
  },
  [TOK.OPEN_PAREN]: (state) => {
    state.handler = element2;
    state.level = 1;
    return 'GROUP_OPEN';
  },
});
const element0: Handler = step('ELEMENT_NONE', {
  [TOK.NAME]: [element1, 'ELEMENT_NAME'],
  [TOK.PREFIXED_NAME]: [element1, 'ELEMENT_NAME'],
});
