// Lists the public members of .NET types, for DOTNET_MEMBERS in src/csharp/library/dotnetNames.ts: one entry per type
// that the grader's library declares, so that a member .NET has but the library lacks is reported as unavailable. Run
// with the .NET SDK the interpreter follows, passing a file of the library's declared types' metadata names:
//   dotnet run scripts/csharpData/listDotnetMembers.cs -- declared-types.txt
// With `--overloads` after the file, it lists instead each constructor's and method's overloads by the numbers of
// arguments they take, for DOTNET_OVERLOADS in src/csharp/library/dotnetOverloads.ts.
using System.Reflection;

var directory = Path.GetDirectoryName(typeof(object).Assembly.Location)!;
var types = new Dictionary<string, Type>(StringComparer.Ordinal);
foreach (var file in Directory.GetFiles(directory, "*.dll"))
{
    Type[] exported;
    try
    {
        var assembly =
            Path.GetFileName(file) == "System.Private.CoreLib.dll" ? typeof(object).Assembly : Assembly.LoadFrom(file);
        exported = assembly.GetExportedTypes();
    }
    catch (Exception error) when (error is BadImageFormatException or FileLoadException or ReflectionTypeLoadException)
    {
        // Native libraries and facades that fail to load export no types of their own.
        continue;
    }
    foreach (var type in exported)
        if (type.FullName is { } name) types.TryAdd(name, type);
}
const BindingFlags flags = BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.FlattenHierarchy;
var listsOverloads = args.Length > 1 && args[1] == "--overloads";
var names = File.ReadAllLines(args[0]).Where((line) => line.Length > 0).Order(StringComparer.Ordinal);
foreach (var name in names)
{
    // A type of the library's own, such as Turtle, has no .NET members to list.
    if (!types.TryGetValue(name, out var type)) continue;
    if (listsOverloads)
    {
        // Each overload as `min-max` arguments, `min+` when a params array takes any number more.
        var overloads = type.GetMembers(flags)
            .OfType<MethodBase>()
            .Where((method) => method is ConstructorInfo || !method.IsSpecialName)
            .GroupBy((method) => method is ConstructorInfo ? ".ctor" : method.Name)
            .OrderBy((group) => group.Key, StringComparer.Ordinal)
            .Select((group) => $"{group.Key}={string.Join(",", group.Select(RangeOf))}");
        Console.WriteLine($"  '{name}': '{string.Join(";", overloads)}',");
        continue;
    }
    var members = type.GetMembers(flags)
        .Where((member) => member is not ConstructorInfo)
        .Where((member) => member is not MethodInfo { IsSpecialName: true } method || method.Name.StartsWith("op_"))
        .Select((member) => member.Name)
        .Distinct()
        .Order(StringComparer.Ordinal);
    Console.WriteLine($"  '{name}': '{string.Join(",", members)}',");
}

static string RangeOf(MethodBase method)
{
    var parameters = method.GetParameters();
    var required = parameters.Count((parameter) => !parameter.IsOptional && !parameter.IsDefined(typeof(ParamArrayAttribute)));
    var takesMore = parameters.Length > 0 && parameters[^1].IsDefined(typeof(ParamArrayAttribute));
    return takesMore ? $"{required}+" : $"{required}-{parameters.Length}";
}
