/** Where an annotation is written, as the targets of `@Target` and the use-site targets such as `@get:` name it. */
export interface AnnotationSite {
  /** The `AnnotationTarget`s the element is, any of which an annotation without a use-site target may apply to. */
  targets: readonly string[];
  /** The use-site targets the element accepts, as `get` and `field` on a property. */
  useSites: ReadonlySet<string>;
}

export function annotationSite(targets: readonly string[], useSites: readonly string[] = []): AnnotationSite {
  return { targets, useSites: new Set(useSites) };
}
