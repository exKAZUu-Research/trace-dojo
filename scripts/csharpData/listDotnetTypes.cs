// Lists the public top-level types of the given namespaces across the shared framework that runs this script, for
// DOTNET_TYPES in src/csharp/library/dotnetNames.ts. Run with the .NET SDK the interpreter follows:
//   dotnet run scripts/csharpData/listDotnetTypes.cs -- System System.Collections ...
using System.Reflection;

var namespaces = new HashSet<string>(args);
var directory = Path.GetDirectoryName(typeof(object).Assembly.Location)!;
var names = new SortedSet<string>(StringComparer.Ordinal);
foreach (var file in Directory.GetFiles(directory, "*.dll"))
{
    Type[] types;
    try
    {
        var assembly =
            Path.GetFileName(file) == "System.Private.CoreLib.dll" ? typeof(object).Assembly : Assembly.LoadFrom(file);
        types = assembly.GetExportedTypes();
    }
    catch (Exception error) when (error is BadImageFormatException or FileLoadException or ReflectionTypeLoadException)
    {
        // Native libraries and facades that fail to load export no types of their own.
        continue;
    }
    foreach (var type in types)
        if (!type.IsNested && type.Namespace is { } name && namespaces.Contains(name)) names.Add(type.FullName!);
}
foreach (var name in names) Console.WriteLine(name);
