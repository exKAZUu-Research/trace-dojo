// Run on JDK 25 with Kotlin 2.4.21 and kotlin-metadata-jvm.jar on kotlinc's classpath.
// Redirect script stdout to src/kotlin/libraryApiData.ts.
import java.io.File
import java.lang.reflect.Modifier
import java.net.URI
import java.nio.file.FileSystems
import java.nio.file.Files
import java.util.jar.JarFile
import kotlin.metadata.*
import kotlin.metadata.jvm.KotlinClassMetadata

check(KotlinVersion.CURRENT == KotlinVersion(2, 4, 21))
check(Runtime.version().feature() == 25)

val defaultPackages = setOf(
    "kotlin", "kotlin.collections", "kotlin.comparisons", "kotlin.io", "kotlin.jvm",
    "kotlin.ranges", "kotlin.sequences", "kotlin.text",
)
val members = sortedMapOf<String, MutableSet<String>>()
val declarations = sortedMapOf<String, MutableSet<String>>()

fun isPublicApi(visibility: Visibility, annotations: List<KmAnnotation>): Boolean =
    visibility == Visibility.PUBLIC && annotations.none { annotation ->
        annotation.className == "kotlin/Deprecated" &&
            (annotation.arguments["level"] as? KmAnnotationArgument.EnumValue)?.enumEntryName == "HIDDEN"
    }

fun receiverName(type: KmType, parameters: List<KmTypeParameter>): String? =
    when (val classifier = type.classifier) {
        is KmClassifier.Class -> classifier.name
        is KmClassifier.TypeAlias -> classifier.name
        is KmClassifier.TypeParameter -> {
            val bounds = parameters.firstOrNull { it.id == classifier.id }?.upperBounds.orEmpty()
            when (bounds.size) {
                0 -> "kotlin/Any"
                1 -> receiverName(bounds.single(), parameters)
                else -> null
            }
        }
    }

fun collect(container: KmDeclarationContainer, owner: String? = null) {
    fun add(name: String, receiver: KmType?, parameters: List<KmTypeParameter>) {
        val type = if (receiver == null) owner else receiverName(receiver, parameters)
        if (type != null && name.matches(Regex("[A-Za-z][A-Za-z0-9_]*"))) {
            members.getOrPut(type.replace('/', '.')) { sortedSetOf() }.add(name)
        }
    }

    for (function in container.functions.filter { isPublicApi(it.visibility, it.annotations) }) {
        add(function.name, function.receiverParameterType, function.typeParameters)
    }
    for (property in container.properties.filter { isPublicApi(it.visibility, it.annotations) }) {
        add(property.name, property.receiverParameterType, property.typeParameters)
    }
}

fun collectPackage(packageName: String, pkg: KmPackage) {
    val names = declarations.getOrPut(packageName) { sortedSetOf() }
    names.addAll(pkg.functions.filter { it.receiverParameterType == null && isPublicApi(it.visibility, it.annotations) }.map { it.name })
    names.addAll(pkg.properties.filter { it.receiverParameterType == null && isPublicApi(it.visibility, it.annotations) }.map { it.name })
    names.addAll(pkg.typeAliases.filter { isPublicApi(it.visibility, it.annotations) }.map { it.name })
    if (packageName in defaultPackages) collect(pkg)
}

val stdlib = Unit::class.java
JarFile(File(stdlib.protectionDomain.codeSource.location.toURI())).use { jar ->
    for (entry in jar.entries()) {
        if (!entry.name.startsWith("kotlin/") || !entry.name.endsWith(".class")) continue
        val className = entry.name.removeSuffix(".class").replace('/', '.')
        val clazz = try {
            Class.forName(className, false, stdlib.classLoader)
        } catch (_: LinkageError) {
            continue
        }
        val annotation = clazz.getAnnotation(Metadata::class.java) ?: continue
        when (val metadata = KotlinClassMetadata.readStrict(annotation)) {
            is KotlinClassMetadata.Class -> {
                val klass = metadata.kmClass
                if (isPublicApi(klass.visibility, klass.annotations)) {
                    val packageName = klass.name.substringBeforeLast('/').replace('/', '.')
                    val name = klass.name.substringAfterLast('/')
                    declarations.getOrPut(packageName) { sortedSetOf() }.add(name)
                    collect(klass, klass.name)
                }
            }
            is KotlinClassMetadata.FileFacade -> collectPackage(clazz.packageName, metadata.kmPackage)
            is KotlinClassMetadata.MultiFileClassPart -> collectPackage(clazz.packageName, metadata.kmPackage)
            else -> Unit
        }
    }
}

val langClasses = FileSystems.getFileSystem(URI.create("jrt:/")).getPath("/modules/java.base/java/lang")
Files.list(langClasses).use { files ->
    val names = declarations.getOrPut("java.lang") { sortedSetOf() }
    files.forEach { file ->
        val name = file.fileName.toString().removeSuffix(".class")
        if (name.matches(Regex("[A-Z][A-Za-z0-9]*"))) {
            val type = Class.forName("java.lang.$name", false, null)
            if (Modifier.isPublic(type.modifiers)) names.add(name)
        }
    }
}
members["java.lang.System"] = System::class.java.methods
    .filter { Modifier.isStatic(it.modifiers) }.map { it.name }.toSortedSet()

println("// Generated by scripts/generateKotlinLibraryMembers.kts from Kotlin/JVM 2.4.21.")
println("export const libraryMemberNames: Readonly<Record<string, string>> = {")
for ((type, names) in members) {
    println("  '$type': '${names.joinToString(" ")}',")
}
println("};")

println()
println("export const libraryDeclarationNames: Readonly<Record<string, string>> = {")
for ((pkg, names) in declarations) {
    val identifiers = names.filter { it.matches(Regex("[A-Za-z][A-Za-z0-9_.]*")) }
    if (identifiers.isNotEmpty()) println("  '$pkg': '${identifiers.joinToString(" ")}',")
}
println("};")
