// code-gauge-allow-file duplicateLines -- Each script runs alone with `dotnet run`, so it cannot share the assembly loading with the other.
// Lists the public top-level types of the namespaces below across the shared framework that runs this script, for
// DOTNET_TYPES in src/csharp/library/dotnetNames.ts. Run with the .NET SDK the interpreter follows:
//   dotnet run scripts/csharpData/listDotnetTypes.cs
using System.Reflection;

string[] namespaces =
[
    "System",
    "System.Collections",
    "System.Collections.Concurrent",
    "System.Collections.Generic",
    "System.Collections.ObjectModel",
    "System.Collections.Specialized",
    "System.Diagnostics",
    "System.Globalization",
    "System.IO",
    "System.Linq",
    "System.Net",
    "System.Net.Http",
    "System.Numerics",
    "System.Reflection",
    "System.Text",
    "System.Text.RegularExpressions",
    "System.Threading",
    "System.Threading.Tasks",
];
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
