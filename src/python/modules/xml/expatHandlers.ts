import type { ContentModel } from './expatDocument';

/**
 * The callbacks of an expat parser, which the parser reads each time it reports an event, as expat reads its handler
 * pointers: one that is undefined is not set.
 */
export interface ExpatHandlers {
  startElement?: (name: string, attributes: string[], specified: number) => void;
  endElement?: (name: string) => void;
  characterData?: (data: string) => void;
  processingInstruction?: (target: string, data: string) => void;
  comment?: (data: string) => void;
  startCdataSection?: () => void;
  endCdataSection?: () => void;
  default?: (data: string) => void;
  xmlDecl?: (version: string | undefined, encoding: string | undefined, standalone: number) => void;
  startDoctypeDecl?: (
    name: string,
    systemId: string | undefined,
    publicId: string | undefined,
    hasInternalSubset: boolean
  ) => void;
  endDoctypeDecl?: () => void;
  entityDecl?: (
    name: string,
    isParam: boolean,
    value: string | undefined,
    base: string | undefined,
    systemId: string | undefined,
    publicId: string | undefined,
    notation: string | undefined
  ) => void;
  unparsedEntityDecl?: (
    name: string,
    base: string | undefined,
    systemId: string | undefined,
    publicId: string | undefined,
    notation: string
  ) => void;
  notationDecl?: (
    name: string,
    base: string | undefined,
    systemId: string | undefined,
    publicId: string | undefined
  ) => void;
  elementDecl?: (name: string, model: ContentModel) => void;
  attlistDecl?: (
    element: string,
    attribute: string,
    type: string,
    value: string | undefined,
    isRequired: boolean
  ) => void;
  startNamespaceDecl?: (prefix: string | undefined, uri: string | undefined) => void;
  endNamespaceDecl?: (prefix: string | undefined) => void;
  notStandalone?: () => boolean;
  externalEntityRef?: (
    context: string,
    base: string | undefined,
    systemId: string | undefined,
    publicId: string | undefined
  ) => boolean;
  skippedEntity?: (name: string, isParam: boolean) => void;
}
