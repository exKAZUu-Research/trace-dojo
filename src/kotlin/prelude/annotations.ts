import { kotlin } from './source';

const ALL_TARGETS =
  'AnnotationTarget.CLASS, AnnotationTarget.ANNOTATION_CLASS, AnnotationTarget.PROPERTY, AnnotationTarget.FIELD, AnnotationTarget.LOCAL_VARIABLE, AnnotationTarget.VALUE_PARAMETER, AnnotationTarget.CONSTRUCTOR, AnnotationTarget.FUNCTION, AnnotationTarget.PROPERTY_GETTER, AnnotationTarget.PROPERTY_SETTER, AnnotationTarget.TYPE, AnnotationTarget.EXPRESSION, AnnotationTarget.FILE, AnnotationTarget.TYPEALIAS';
const OPT_IN_TARGETS =
  'AnnotationTarget.CLASS, AnnotationTarget.PROPERTY, AnnotationTarget.LOCAL_VARIABLE, AnnotationTarget.VALUE_PARAMETER, AnnotationTarget.CONSTRUCTOR, AnnotationTarget.FUNCTION, AnnotationTarget.PROPERTY_GETTER, AnnotationTarget.PROPERTY_SETTER, AnnotationTarget.EXPRESSION, AnnotationTarget.FILE, AnnotationTarget.TYPEALIAS';
const MARKER_TARGETS =
  'AnnotationTarget.CLASS, AnnotationTarget.ANNOTATION_CLASS, AnnotationTarget.PROPERTY, AnnotationTarget.FIELD, AnnotationTarget.LOCAL_VARIABLE, AnnotationTarget.VALUE_PARAMETER, AnnotationTarget.CONSTRUCTOR, AnnotationTarget.FUNCTION, AnnotationTarget.PROPERTY_GETTER, AnnotationTarget.PROPERTY_SETTER, AnnotationTarget.TYPEALIAS';

/** An opt-in marker of the standard library, which `@OptIn` names to use what it marks. */
function marker(name: string): string {
  return `@RequiresOptIn
@Target(${MARKER_TARGETS})
annotation class ${name}`;
}

/** The annotations of the standard library, declared as Kotlin's standard library declares them. */
export const ANNOTATION_SOURCES = [
  kotlin`
package kotlin.annotation

enum class AnnotationTarget {
    CLASS, ANNOTATION_CLASS, TYPE_PARAMETER, PROPERTY, FIELD, LOCAL_VARIABLE, VALUE_PARAMETER, CONSTRUCTOR, FUNCTION,
    PROPERTY_GETTER, PROPERTY_SETTER, TYPE, EXPRESSION, FILE, TYPEALIAS
}

enum class AnnotationRetention { SOURCE, BINARY, RUNTIME }

@Target(AnnotationTarget.ANNOTATION_CLASS)
annotation class Target(vararg val allowedTargets: AnnotationTarget)

@Target(AnnotationTarget.ANNOTATION_CLASS)
annotation class Retention(val value: AnnotationRetention = AnnotationRetention.RUNTIME)

@Target(AnnotationTarget.ANNOTATION_CLASS)
annotation class Repeatable

@Target(AnnotationTarget.ANNOTATION_CLASS)
annotation class MustBeDocumented
`,
  `package kotlin

import kotlin.reflect.KClass

interface Annotation

enum class DeprecationLevel { WARNING, ERROR, HIDDEN }

@Target(AnnotationTarget.CLASS, AnnotationTarget.FUNCTION, AnnotationTarget.PROPERTY, AnnotationTarget.ANNOTATION_CLASS, AnnotationTarget.CONSTRUCTOR, AnnotationTarget.PROPERTY_SETTER, AnnotationTarget.PROPERTY_GETTER, AnnotationTarget.TYPEALIAS)
@MustBeDocumented
annotation class Deprecated(val message: String, val replaceWith: ReplaceWith = ReplaceWith(""), val level: DeprecationLevel = DeprecationLevel.WARNING)

@Target(AnnotationTarget.CLASS, AnnotationTarget.FUNCTION, AnnotationTarget.PROPERTY, AnnotationTarget.ANNOTATION_CLASS, AnnotationTarget.CONSTRUCTOR, AnnotationTarget.PROPERTY_SETTER, AnnotationTarget.PROPERTY_GETTER, AnnotationTarget.TYPEALIAS)
annotation class DeprecatedSinceKotlin(val warningSince: String = "", val errorSince: String = "", val hiddenSince: String = "")

@Target()
@MustBeDocumented
annotation class ReplaceWith(val expression: String, vararg val imports: String)

@Target(${ALL_TARGETS})
@Retention(AnnotationRetention.SOURCE)
annotation class Suppress(vararg val names: String)

@Target(${OPT_IN_TARGETS})
@Retention(AnnotationRetention.SOURCE)
annotation class OptIn(vararg val markerClass: KClass<out Annotation>)

@Target(AnnotationTarget.ANNOTATION_CLASS)
@Retention(AnnotationRetention.BINARY)
annotation class RequiresOptIn(val message: String = "", val level: Level = Level.ERROR) {
    enum class Level { WARNING, ERROR }
}

@Target(AnnotationTarget.CLASS)
annotation class SubclassOptInRequired(vararg val markerClass: KClass<out Annotation>)

@Target(AnnotationTarget.CLASS, AnnotationTarget.PROPERTY, AnnotationTarget.CONSTRUCTOR, AnnotationTarget.FUNCTION, AnnotationTarget.PROPERTY_GETTER, AnnotationTarget.PROPERTY_SETTER)
annotation class PublishedApi

@Target(AnnotationTarget.CLASS, AnnotationTarget.PROPERTY, AnnotationTarget.FIELD, AnnotationTarget.CONSTRUCTOR, AnnotationTarget.FUNCTION, AnnotationTarget.PROPERTY_GETTER, AnnotationTarget.PROPERTY_SETTER, AnnotationTarget.TYPEALIAS)
annotation class SinceKotlin(val version: String)

@Target(AnnotationTarget.ANNOTATION_CLASS)
annotation class DslMarker

@Target(AnnotationTarget.TYPE)
annotation class UnsafeVariance

@Target(AnnotationTarget.TYPE)
annotation class ExtensionFunctionType

@Target(AnnotationTarget.TYPE)
annotation class ParameterName(val name: String)

@Target(AnnotationTarget.VALUE_PARAMETER, AnnotationTarget.FUNCTION, AnnotationTarget.PROPERTY)
annotation class BuilderInference

@Target(AnnotationTarget.FUNCTION)
annotation class OverloadResolutionByLambdaReturnType

@Target(AnnotationTarget.CLASS)
annotation class ConsistentCopyVisibility

@Target(AnnotationTarget.CLASS)
annotation class ExposedCopyVisibility

${['ExperimentalStdlibApi', 'ExperimentalUnsignedTypes', 'ExperimentalMultiplatform', 'ExperimentalSubclassOptIn'].map(marker).join('\n\n')}
`,
  kotlin`
package kotlin.jvm

import kotlin.reflect.KClass

@Target(AnnotationTarget.CLASS)
annotation class JvmInline

@Target(AnnotationTarget.FUNCTION, AnnotationTarget.PROPERTY, AnnotationTarget.PROPERTY_GETTER, AnnotationTarget.PROPERTY_SETTER)
annotation class JvmStatic

@Target(AnnotationTarget.FUNCTION, AnnotationTarget.PROPERTY_GETTER, AnnotationTarget.PROPERTY_SETTER, AnnotationTarget.FILE)
annotation class JvmName(val name: String)

@Target(AnnotationTarget.FIELD)
annotation class JvmField

@Target(AnnotationTarget.FUNCTION, AnnotationTarget.CONSTRUCTOR)
annotation class JvmOverloads

@Target(AnnotationTarget.CLASS, AnnotationTarget.FUNCTION, AnnotationTarget.PROPERTY, AnnotationTarget.TYPE)
annotation class JvmSuppressWildcards(val suppress: Boolean = true)

@Target(AnnotationTarget.TYPE)
annotation class JvmWildcard

@Target(AnnotationTarget.FILE)
annotation class JvmMultifileClass

@Target(AnnotationTarget.FILE, AnnotationTarget.FUNCTION, AnnotationTarget.PROPERTY_GETTER, AnnotationTarget.PROPERTY_SETTER, AnnotationTarget.FIELD)
annotation class JvmSynthetic

@Target(AnnotationTarget.CLASS)
annotation class JvmRecord

@Target(AnnotationTarget.FUNCTION, AnnotationTarget.PROPERTY_GETTER, AnnotationTarget.PROPERTY_SETTER, AnnotationTarget.CONSTRUCTOR)
annotation class Throws(vararg val exceptionClasses: KClass<out Throwable>)

@Target(AnnotationTarget.FUNCTION, AnnotationTarget.PROPERTY_GETTER, AnnotationTarget.PROPERTY_SETTER)
annotation class Synchronized

@Target(AnnotationTarget.FIELD)
annotation class Volatile

@Target(AnnotationTarget.FIELD)
annotation class Transient

@Target(AnnotationTarget.FUNCTION, AnnotationTarget.CONSTRUCTOR, AnnotationTarget.PROPERTY_GETTER, AnnotationTarget.PROPERTY_SETTER, AnnotationTarget.CLASS)
annotation class Strictfp

@Target(AnnotationTarget.CLASS)
annotation class JvmDefaultWithCompatibility

@Target(AnnotationTarget.CLASS)
annotation class JvmDefaultWithoutCompatibility

@Target(AnnotationTarget.EXPRESSION)
annotation class JvmSerializableLambda
`,
  kotlin`
package kotlin.concurrent

@Target(AnnotationTarget.FIELD)
annotation class Volatile
`,
  ...[
    ['kotlin.time', 'ExperimentalTime'],
    ['kotlin.experimental', 'ExperimentalTypeInference'],
    ['kotlin.contracts', 'ExperimentalContracts'],
    ['kotlin.io.encoding', 'ExperimentalEncodingApi'],
    ['kotlin.uuid', 'ExperimentalUuidApi'],
    ['kotlin.concurrent.atomics', 'ExperimentalAtomicApi'],
    ['kotlin.io.path', 'ExperimentalPathApi'],
  ].map(([packageName, name]) => `package ${packageName}\n\n${marker(name)}\n`),
];
