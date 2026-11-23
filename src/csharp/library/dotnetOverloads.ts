// The overloads of the .NET 10 types this grader declares, by the numbers of arguments each takes (`min-max`, or
// `min+` with a params array), so that a call fitting a .NET overload the library lacks is reported as unavailable
// rather than as a wrong call: the output of scripts/csharpData/listDotnetMembers.cs with `--overloads`.
export const DOTNET_OVERLOADS: Readonly<Record<string, string>> = {
  'System.Action':
    '.ctor=2-2;BeginInvoke=2-2;Clone=0-0;Combine=2-2,0+,1-1;CreateDelegate=5-5,5-5,3-3,4-4,3-3,2-2,3-3,4-4,3-3,4-4;DynamicInvoke=0+;EndInvoke=1-1;EnumerateInvocationList=1-1;Equals=1-1,2-2;GetHashCode=0-0;GetInvocationList=0-0;GetObjectData=2-2;GetType=0-0;Invoke=0-0;ReferenceEquals=2-2;Remove=2-2;RemoveAll=2-2;ToString=0-0',
  'System.Action`1':
    '.ctor=2-2;BeginInvoke=3-3;Clone=0-0;Combine=2-2,0+,1-1;CreateDelegate=5-5,5-5,3-3,4-4,3-3,2-2,3-3,4-4,3-3,4-4;DynamicInvoke=0+;EndInvoke=1-1;EnumerateInvocationList=1-1;Equals=1-1,2-2;GetHashCode=0-0;GetInvocationList=0-0;GetObjectData=2-2;GetType=0-0;Invoke=1-1;ReferenceEquals=2-2;Remove=2-2;RemoveAll=2-2;ToString=0-0',
  'System.Action`2':
    '.ctor=2-2;BeginInvoke=4-4;Clone=0-0;Combine=2-2,0+,1-1;CreateDelegate=5-5,5-5,3-3,4-4,3-3,2-2,3-3,4-4,3-3,4-4;DynamicInvoke=0+;EndInvoke=1-1;EnumerateInvocationList=1-1;Equals=1-1,2-2;GetHashCode=0-0;GetInvocationList=0-0;GetObjectData=2-2;GetType=0-0;Invoke=2-2;ReferenceEquals=2-2;Remove=2-2;RemoveAll=2-2;ToString=0-0',
  'System.Action`3':
    '.ctor=2-2;BeginInvoke=5-5;Clone=0-0;Combine=2-2,0+,1-1;CreateDelegate=5-5,5-5,3-3,4-4,3-3,2-2,3-3,4-4,3-3,4-4;DynamicInvoke=0+;EndInvoke=1-1;EnumerateInvocationList=1-1;Equals=1-1,2-2;GetHashCode=0-0;GetInvocationList=0-0;GetObjectData=2-2;GetType=0-0;Invoke=3-3;ReferenceEquals=2-2;Remove=2-2;RemoveAll=2-2;ToString=0-0',
  'System.Action`4':
    '.ctor=2-2;BeginInvoke=6-6;Clone=0-0;Combine=2-2,0+,1-1;CreateDelegate=5-5,5-5,3-3,4-4,3-3,2-2,3-3,4-4,3-3,4-4;DynamicInvoke=0+;EndInvoke=1-1;EnumerateInvocationList=1-1;Equals=1-1,2-2;GetHashCode=0-0;GetInvocationList=0-0;GetObjectData=2-2;GetType=0-0;Invoke=4-4;ReferenceEquals=2-2;Remove=2-2;RemoveAll=2-2;ToString=0-0',
  'System.Action`5':
    '.ctor=2-2;BeginInvoke=7-7;Clone=0-0;Combine=2-2,0+,1-1;CreateDelegate=5-5,5-5,3-3,4-4,3-3,2-2,3-3,4-4,3-3,4-4;DynamicInvoke=0+;EndInvoke=1-1;EnumerateInvocationList=1-1;Equals=1-1,2-2;GetHashCode=0-0;GetInvocationList=0-0;GetObjectData=2-2;GetType=0-0;Invoke=5-5;ReferenceEquals=2-2;Remove=2-2;RemoveAll=2-2;ToString=0-0',
  'System.Action`6':
    '.ctor=2-2;BeginInvoke=8-8;Clone=0-0;Combine=2-2,0+,1-1;CreateDelegate=5-5,5-5,3-3,4-4,3-3,2-2,3-3,4-4,3-3,4-4;DynamicInvoke=0+;EndInvoke=1-1;EnumerateInvocationList=1-1;Equals=1-1,2-2;GetHashCode=0-0;GetInvocationList=0-0;GetObjectData=2-2;GetType=0-0;Invoke=6-6;ReferenceEquals=2-2;Remove=2-2;RemoveAll=2-2;ToString=0-0',
  'System.ApplicationException':
    '.ctor=0-0,1-1,2-2;Equals=1-1,2-2;GetBaseException=0-0;GetHashCode=0-0;GetObjectData=2-2;GetType=0-0,0-0;ReferenceEquals=2-2;ToString=0-0',
  'System.ArgumentException':
    '.ctor=0-0,1-1,2-2,3-3,2-2;Equals=1-1,2-2;GetBaseException=0-0;GetHashCode=0-0;GetObjectData=2-2;GetType=0-0,0-0;ReferenceEquals=2-2;ThrowIfNullOrEmpty=1-2;ThrowIfNullOrWhiteSpace=1-2;ToString=0-0',
  'System.ArgumentNullException':
    '.ctor=0-0,1-1,2-2,2-2;Equals=1-1,2-2;GetBaseException=0-0;GetHashCode=0-0;GetObjectData=2-2;GetType=0-0,0-0;ReferenceEquals=2-2;ThrowIfNull=1-2,1-2;ThrowIfNullOrEmpty=1-2;ThrowIfNullOrWhiteSpace=1-2;ToString=0-0',
  'System.ArgumentOutOfRangeException':
    '.ctor=0-0,1-1,2-2,2-2,3-3;Equals=1-1,2-2;GetBaseException=0-0;GetHashCode=0-0;GetObjectData=2-2;GetType=0-0,0-0;ReferenceEquals=2-2;ThrowIfEqual=2-3;ThrowIfGreaterThan=2-3;ThrowIfGreaterThanOrEqual=2-3;ThrowIfLessThan=2-3;ThrowIfLessThanOrEqual=2-3;ThrowIfNegative=1-2;ThrowIfNegativeOrZero=1-2;ThrowIfNotEqual=2-3;ThrowIfNullOrEmpty=1-2;ThrowIfNullOrWhiteSpace=1-2;ThrowIfZero=1-2;ToString=0-0',
  'System.ArithmeticException':
    '.ctor=0-0,1-1,2-2;Equals=1-1,2-2;GetBaseException=0-0;GetHashCode=0-0;GetObjectData=2-2;GetType=0-0,0-0;ReferenceEquals=2-2;ToString=0-0',
  'System.Array':
    'AsReadOnly=1-1;BinarySearch=2-2,4-4,3-3,5-5,2-2,3-3,4-4,5-5;Clear=1-1,3-3;Clone=0-0;ConstrainedCopy=5-5;ConvertAll=2-2;Copy=3-3,5-5,3-3,5-5;CopyTo=2-2,2-2;CreateInstance=2-2,3-3,4-4,1+,3-3,1+;CreateInstanceFromArrayType=2-2,1+,3-3;Empty=0-0;Equals=1-1,2-2;Exists=2-2;Fill=2-2,4-4;Find=2-2;FindAll=2-2;FindIndex=2-2,3-3,4-4;FindLast=2-2;FindLastIndex=2-2,3-3,4-4;ForEach=2-2;GetEnumerator=0-0;GetHashCode=0-0;GetLength=1-1;GetLongLength=1-1;GetLowerBound=1-1;GetType=0-0;GetUpperBound=1-1;GetValue=0+,1-1,2-2,3-3,1-1,2-2,3-3,0+;IndexOf=2-2,3-3,4-4,2-2,3-3,4-4;Initialize=0-0;LastIndexOf=2-2,3-3,4-4,2-2,3-3,4-4;ReferenceEquals=2-2;Resize=2-2;Reverse=1-1,3-3,1-1,3-3;SetValue=2-2,3-3,4-4,1+,2-2,3-3,4-4,1+;Sort=1-1,2-2,3-3,4-4,2-2,3-3,4-4,5-5,1-1,2-2,3-3,4-4,2-2,3-3,4-4,5-5,2-2;ToString=0-0;TrueForAll=2-2',
  'System.ArrayTypeMismatchException':
    '.ctor=0-0,1-1,2-2;Equals=1-1,2-2;GetBaseException=0-0;GetHashCode=0-0;GetObjectData=2-2;GetType=0-0,0-0;ReferenceEquals=2-2;ToString=0-0',
  'System.Boolean':
    'CompareTo=1-1,1-1;Equals=1-1,1-1,2-2;GetHashCode=0-0;GetType=0-0;GetTypeCode=0-0;Parse=1-1,1-1;ReferenceEquals=2-2;ToString=0-0,1-1;TryFormat=2-2;TryParse=2-2,2-2',
  'System.Byte':
    'Clamp=3-3;CompareTo=1-1,1-1;CreateChecked=1-1;CreateSaturating=1-1;CreateTruncating=1-1;DivRem=2-2;Equals=1-1,1-1,2-2;GetHashCode=0-0;GetType=0-0;GetTypeCode=0-0;IsEvenInteger=1-1;IsOddInteger=1-1;IsPow2=1-1;LeadingZeroCount=1-1;Log2=1-1;Max=2-2;Min=2-2;Parse=1-1,2-2,2-2,3-3,1-3,2-2,1-3,2-2;PopCount=1-1;ReferenceEquals=2-2;RotateLeft=2-2;RotateRight=2-2;Sign=1-1;ToString=0-0,1-1,1-1,2-2;TrailingZeroCount=1-1;TryFormat=2-4,2-4;TryParse=2-2,2-2,2-2,4-4,4-4,3-3,3-3,4-4,3-3',
  'System.Char':
    'CompareTo=1-1,1-1;ConvertFromUtf32=1-1;ConvertToUtf32=2-2,2-2;Equals=1-1,1-1,2-2;GetHashCode=0-0;GetNumericValue=1-1,2-2;GetType=0-0;GetTypeCode=0-0;GetUnicodeCategory=1-1,2-2;IsAscii=1-1;IsAsciiDigit=1-1;IsAsciiHexDigit=1-1;IsAsciiHexDigitLower=1-1;IsAsciiHexDigitUpper=1-1;IsAsciiLetter=1-1;IsAsciiLetterLower=1-1;IsAsciiLetterOrDigit=1-1;IsAsciiLetterUpper=1-1;IsBetween=3-3;IsControl=1-1,2-2;IsDigit=1-1,2-2;IsHighSurrogate=1-1,2-2;IsLetter=1-1,2-2;IsLetterOrDigit=1-1,2-2;IsLowSurrogate=1-1,2-2;IsLower=1-1,2-2;IsNumber=1-1,2-2;IsPunctuation=1-1,2-2;IsSeparator=1-1,2-2;IsSurrogate=1-1,2-2;IsSurrogatePair=2-2,2-2;IsSymbol=1-1,2-2;IsUpper=1-1,2-2;IsWhiteSpace=1-1,2-2;Parse=1-1;ReferenceEquals=2-2;ToLower=2-2,1-1;ToLowerInvariant=1-1;ToString=0-0,1-1,1-1;ToUpper=2-2,1-1;ToUpperInvariant=1-1;TryParse=2-2',
  'System.CharEnumerator':
    'Clone=0-0;Dispose=0-0;Equals=1-1,2-2;GetHashCode=0-0;GetType=0-0;MoveNext=0-0;ReferenceEquals=2-2;Reset=0-0;ToString=0-0',
  'System.Collections.Generic.CollectionExtensions':
    'AddRange=2-2;AsReadOnly=1-1,1-1,1-1;CopyTo=2-2;Equals=1-1,2-2;GetHashCode=0-0;GetType=0-0;GetValueOrDefault=2-2,3-3;InsertRange=3-3;ReferenceEquals=2-2;Remove=3-3;ToString=0-0;TryAdd=3-3',
  'System.Collections.Generic.Comparer`1':
    'Compare=2-2;Create=1-1;Equals=1-1,2-2;GetHashCode=0-0;GetType=0-0;ReferenceEquals=2-2;ToString=0-0',
  'System.Collections.Generic.Dictionary`2':
    '.ctor=0-0,1-1,1-1,2-2,1-1,2-2,1-1,2-2;Add=2-2;Clear=0-0;ContainsKey=1-1;ContainsValue=1-1;EnsureCapacity=1-1;Equals=1-1,2-2;GetAlternateLookup=0-0;GetEnumerator=0-0;GetHashCode=0-0;GetObjectData=2-2;GetType=0-0;OnDeserialization=1-1;ReferenceEquals=2-2;Remove=1-1,2-2;ToString=0-0;TrimExcess=0-0,1-1;TryAdd=2-2;TryGetAlternateLookup=1-1;TryGetValue=2-2',
  'System.Collections.Generic.EqualityComparer`1':
    'Create=1-2;Equals=2-2,1-1,2-2;GetHashCode=1-1,0-0;GetType=0-0;ReferenceEquals=2-2;ToString=0-0',
  'System.Collections.Generic.HashSet`1':
    '.ctor=0-0,1-1,1-1,1-1,2-2,2-2;Add=1-1;Clear=0-0;Contains=1-1;CopyTo=1-1,2-2,3-3;CreateSetComparer=0-0;EnsureCapacity=1-1;Equals=1-1,2-2;ExceptWith=1-1;GetAlternateLookup=0-0;GetEnumerator=0-0;GetHashCode=0-0;GetObjectData=2-2;GetType=0-0;IntersectWith=1-1;IsProperSubsetOf=1-1;IsProperSupersetOf=1-1;IsSubsetOf=1-1;IsSupersetOf=1-1;OnDeserialization=1-1;Overlaps=1-1;ReferenceEquals=2-2;Remove=1-1;RemoveWhere=1-1;SetEquals=1-1;SymmetricExceptWith=1-1;ToString=0-0;TrimExcess=0-0,1-1;TryGetAlternateLookup=1-1;TryGetValue=2-2;UnionWith=1-1',
  'System.Collections.Generic.ICollection`1': 'Add=1-1;Clear=0-0;Contains=1-1;CopyTo=2-2;Remove=1-1',
  'System.Collections.Generic.IComparer`1': 'Compare=2-2',
  'System.Collections.Generic.IDictionary`2': 'Add=2-2;ContainsKey=1-1;Remove=1-1;TryGetValue=2-2',
  'System.Collections.Generic.IEnumerable`1': 'GetEnumerator=0-0',
  'System.Collections.Generic.IEnumerator`1': '',
  'System.Collections.Generic.IEqualityComparer`1': 'Equals=2-2;GetHashCode=1-1',
  'System.Collections.Generic.IList`1': 'IndexOf=1-1;Insert=2-2;RemoveAt=1-1',
  'System.Collections.Generic.IReadOnlyCollection`1': '',
  'System.Collections.Generic.IReadOnlyDictionary`2': 'ContainsKey=1-1;TryGetValue=2-2',
  'System.Collections.Generic.IReadOnlyList`1': '',
  'System.Collections.Generic.IReadOnlySet`1':
    'Contains=1-1;IsProperSubsetOf=1-1;IsProperSupersetOf=1-1;IsSubsetOf=1-1;IsSupersetOf=1-1;Overlaps=1-1;SetEquals=1-1',
  'System.Collections.Generic.ISet`1':
    'Add=1-1;ExceptWith=1-1;IntersectWith=1-1;IsProperSubsetOf=1-1;IsProperSupersetOf=1-1;IsSubsetOf=1-1;IsSupersetOf=1-1;Overlaps=1-1;SetEquals=1-1;SymmetricExceptWith=1-1;UnionWith=1-1',
  'System.Collections.Generic.KeyNotFoundException':
    '.ctor=0-0,1-1,2-2;Equals=1-1,2-2;GetBaseException=0-0;GetHashCode=0-0;GetObjectData=2-2;GetType=0-0,0-0;ReferenceEquals=2-2;ToString=0-0',
  'System.Collections.Generic.KeyValuePair':
    'Create=2-2;Equals=1-1,2-2;GetHashCode=0-0;GetType=0-0;ReferenceEquals=2-2;ToString=0-0',
  'System.Collections.Generic.KeyValuePair`2':
    '.ctor=2-2;Deconstruct=2-2;Equals=1-1,2-2;GetHashCode=0-0;GetType=0-0;ReferenceEquals=2-2;ToString=0-0',
  'System.Collections.Generic.LinkedListNode`1':
    '.ctor=1-1;Equals=1-1,2-2;GetHashCode=0-0;GetType=0-0;ReferenceEquals=2-2;ToString=0-0',
  'System.Collections.Generic.LinkedList`1':
    '.ctor=0-0,1-1;AddAfter=2-2,2-2;AddBefore=2-2,2-2;AddFirst=1-1,1-1;AddLast=1-1,1-1;Clear=0-0;Contains=1-1;CopyTo=2-2;Equals=1-1,2-2;Find=1-1;FindLast=1-1;GetEnumerator=0-0;GetHashCode=0-0;GetObjectData=2-2;GetType=0-0;OnDeserialization=1-1;ReferenceEquals=2-2;Remove=1-1,1-1;RemoveFirst=0-0;RemoveLast=0-0;ToString=0-0',
  'System.Collections.Generic.List`1':
    '.ctor=0-0,1-1,1-1;Add=1-1;AddRange=1-1;AsReadOnly=0-0;BinarySearch=4-4,1-1,2-2;Clear=0-0;Contains=1-1;ConvertAll=1-1;CopyTo=1-1,4-4,2-2;EnsureCapacity=1-1;Equals=1-1,2-2;Exists=1-1;Find=1-1;FindAll=1-1;FindIndex=1-1,2-2,3-3;FindLast=1-1;FindLastIndex=1-1,2-2,3-3;ForEach=1-1;GetEnumerator=0-0;GetHashCode=0-0;GetRange=2-2;GetType=0-0;IndexOf=1-1,2-2,3-3;Insert=2-2;InsertRange=2-2;LastIndexOf=1-1,2-2,3-3;ReferenceEquals=2-2;Remove=1-1;RemoveAll=1-1;RemoveAt=1-1;RemoveRange=2-2;Reverse=0-0,2-2;Slice=2-2;Sort=0-0,1-1,3-3,1-1;ToArray=0-0;ToString=0-0;TrimExcess=0-0;TrueForAll=1-1',
  'System.Collections.Generic.PriorityQueue`2':
    '.ctor=0-0,1-1,1-1,2-2,1-1,2-2;Clear=0-0;Dequeue=0-0;DequeueEnqueue=2-2;Enqueue=2-2;EnqueueDequeue=2-2;EnqueueRange=1-1,2-2;EnsureCapacity=1-1;Equals=1-1,2-2;GetHashCode=0-0;GetType=0-0;Peek=0-0;ReferenceEquals=2-2;Remove=3-4;ToString=0-0;TrimExcess=0-0;TryDequeue=2-2;TryPeek=2-2',
  'System.Collections.Generic.Queue`1':
    '.ctor=0-0,1-1,1-1;Clear=0-0;Contains=1-1;CopyTo=2-2;Dequeue=0-0;Enqueue=1-1;EnsureCapacity=1-1;Equals=1-1,2-2;GetEnumerator=0-0;GetHashCode=0-0;GetType=0-0;Peek=0-0;ReferenceEquals=2-2;ToArray=0-0;ToString=0-0;TrimExcess=0-0,1-1;TryDequeue=1-1;TryPeek=1-1',
  'System.Collections.Generic.SortedDictionary`2':
    '.ctor=0-0,1-1,2-2,1-1;Add=2-2;Clear=0-0;ContainsKey=1-1;ContainsValue=1-1;CopyTo=2-2;Equals=1-1,2-2;GetEnumerator=0-0;GetHashCode=0-0;GetType=0-0;ReferenceEquals=2-2;Remove=1-1;ToString=0-0;TryGetValue=2-2',
  'System.Collections.Generic.SortedList`2':
    '.ctor=0-0,1-1,1-1,2-2,1-1,2-2;Add=2-2;Clear=0-0;ContainsKey=1-1;ContainsValue=1-1;Equals=1-1,2-2;GetEnumerator=0-0;GetHashCode=0-0;GetKeyAtIndex=1-1;GetType=0-0;GetValueAtIndex=1-1;IndexOfKey=1-1;IndexOfValue=1-1;ReferenceEquals=2-2;Remove=1-1;RemoveAt=1-1;SetValueAtIndex=2-2;ToString=0-0;TrimExcess=0-0;TryGetValue=2-2',
  'System.Collections.Generic.SortedSet`1':
    '.ctor=0-0,1-1,1-1,2-2;Add=1-1;Clear=0-0;Contains=1-1;CopyTo=1-1,2-2,3-3;CreateSetComparer=0-0,1-1;Equals=1-1,2-2;ExceptWith=1-1;GetEnumerator=0-0;GetHashCode=0-0;GetType=0-0;GetViewBetween=2-2;IntersectWith=1-1;IsProperSubsetOf=1-1;IsProperSupersetOf=1-1;IsSubsetOf=1-1;IsSupersetOf=1-1;Overlaps=1-1;ReferenceEquals=2-2;Remove=1-1;RemoveWhere=1-1;Reverse=0-0;SetEquals=1-1;SymmetricExceptWith=1-1;ToString=0-0;TryGetValue=2-2;UnionWith=1-1',
  'System.Collections.Generic.Stack`1':
    '.ctor=0-0,1-1,1-1;Clear=0-0;Contains=1-1;CopyTo=2-2;EnsureCapacity=1-1;Equals=1-1,2-2;GetEnumerator=0-0;GetHashCode=0-0;GetType=0-0;Peek=0-0;Pop=0-0;Push=1-1;ReferenceEquals=2-2;ToArray=0-0;ToString=0-0;TrimExcess=0-0,1-1;TryPeek=1-1;TryPop=1-1',
  'System.Collections.ICollection': 'CopyTo=2-2',
  'System.Collections.IComparer': 'Compare=2-2',
  'System.Collections.IDictionary': 'Add=2-2;Clear=0-0;Contains=1-1;GetEnumerator=0-0;Remove=1-1',
  'System.Collections.IEnumerable': 'GetEnumerator=0-0',
  'System.Collections.IEnumerator': 'MoveNext=0-0;Reset=0-0',
  'System.Collections.IEqualityComparer': 'Equals=2-2;GetHashCode=1-1',
  'System.Collections.IList': 'Add=1-1;Clear=0-0;Contains=1-1;IndexOf=1-1;Insert=2-2;Remove=1-1;RemoveAt=1-1',
  'System.Collections.ObjectModel.ReadOnlyCollection`1':
    '.ctor=1-1;Contains=1-1;CopyTo=2-2;Equals=1-1,2-2;GetEnumerator=0-0;GetHashCode=0-0;GetType=0-0;IndexOf=1-1;ReferenceEquals=2-2;ToString=0-0',
  'System.Comparison`1':
    '.ctor=2-2;BeginInvoke=4-4;Clone=0-0;Combine=2-2,0+,1-1;CreateDelegate=5-5,5-5,3-3,4-4,3-3,2-2,3-3,4-4,3-3,4-4;DynamicInvoke=0+;EndInvoke=1-1;EnumerateInvocationList=1-1;Equals=1-1,2-2;GetHashCode=0-0;GetInvocationList=0-0;GetObjectData=2-2;GetType=0-0;Invoke=2-2;ReferenceEquals=2-2;Remove=2-2;RemoveAll=2-2;ToString=0-0',
  'System.Console':
    'Beep=0-0,2-2;Clear=0-0;Equals=1-1,2-2;GetCursorPosition=0-0;GetHashCode=0-0;GetType=0-0;MoveBufferArea=6-6,9-9;OpenStandardError=0-0,1-1;OpenStandardInput=0-0,1-1;OpenStandardOutput=0-0,1-1;Read=0-0;ReadKey=0-0,1-1;ReadLine=0-0;ReferenceEquals=2-2;ResetColor=0-0;SetBufferSize=2-2;SetCursorPosition=2-2;SetError=1-1;SetIn=1-1;SetOut=1-1;SetWindowPosition=2-2;SetWindowSize=2-2;ToString=0-0;Write=2-2,3-3,4-4,1+,2-2,1-1,1-1,1-1,3-3,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1;WriteLine=0-0,1-1,1-1,1-1,3-3,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,2-2,3-3,4-4,1+,2-2',
  'System.ConsoleColor':
    'CompareTo=1-1;Equals=1-1,2-2;Format=3-3;GetHashCode=0-0;GetName=1-1,2-2;GetNames=0-0,1-1;GetType=0-0;GetTypeCode=0-0;GetUnderlyingType=1-1;GetValues=0-0,1-1;GetValuesAsUnderlyingType=0-0,1-1;HasFlag=1-1;IsDefined=1-1,2-2;Parse=2-2,2-2,3-3,3-3,1-1,1-1,2-2,2-2;ReferenceEquals=2-2;ToObject=2-2,2-2,2-2,2-2,2-2,2-2,2-2,2-2,2-2;ToString=0-0,1-1,1-1,2-2;TryFormat=3-4;TryParse=3-3,3-3,4-4,4-4,2-2,2-2,3-3,3-3',
  'System.ConsoleKeyInfo': '.ctor=5-5;Equals=1-1,1-1,2-2;GetHashCode=0-0;GetType=0-0;ReferenceEquals=2-2;ToString=0-0',
  'System.Convert':
    'ChangeType=2-2,3-3,2-2,3-3;Equals=1-1,2-2;FromBase64CharArray=3-3;FromBase64String=1-1;FromHexString=1-1,1-1,1-1,4-4,4-4,4-4;GetHashCode=0-0;GetType=0-0;GetTypeCode=1-1;IsDBNull=1-1;ReferenceEquals=2-2;ToBase64CharArray=5-5,6-6;ToBase64String=1-1,2-2,3-3,4-4,1-2;ToBoolean=1-1,2-2,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,2-2,1-1,1-1,1-1,1-1;ToByte=1-1,2-2,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,2-2,1-1,2-2;ToChar=1-1,2-2,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,2-2,1-1,1-1,1-1,1-1;ToDateTime=1-1,1-1,2-2,1-1,2-2,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1;ToDecimal=1-1,2-2,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,2-2,1-1,1-1,1-1;ToDouble=1-1,2-2,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,2-2,1-1,1-1;ToHexString=1-1,3-3,1-1;ToHexStringLower=1-1,3-3,1-1;ToInt16=1-1,2-2,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,2-2,1-1,2-2;ToInt32=1-1,2-2,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,2-2,1-1,2-2;ToInt64=1-1,2-2,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,2-2,1-1,2-2;ToSByte=1-1,2-2,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,2-2,1-1,2-2;ToSingle=1-1,2-2,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,2-2,1-1,1-1;ToString=1-1,2-2,1-1,2-2,1-1,2-2,1-1,2-2,1-1,2-2,1-1,2-2,1-1,2-2,1-1,2-2,1-1,2-2,1-1,2-2,1-1,2-2,1-1,2-2,1-1,2-2,1-1,2-2,1-1,2-2,1-1,2-2,2-2,2-2,2-2,2-2,0-0;ToUInt16=1-1,2-2,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,2-2,1-1,2-2;ToUInt32=1-1,2-2,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,2-2,1-1,2-2;ToUInt64=1-1,2-2,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,2-2,1-1,2-2;TryFromBase64Chars=3-3;TryFromBase64String=3-3;TryToBase64Chars=3-4;TryToHexString=3-3,3-3;TryToHexStringLower=3-3,3-3',
  'System.Converter`2':
    '.ctor=2-2;BeginInvoke=3-3;Clone=0-0;Combine=2-2,0+,1-1;CreateDelegate=5-5,5-5,3-3,4-4,3-3,2-2,3-3,4-4,3-3,4-4;DynamicInvoke=0+;EndInvoke=1-1;EnumerateInvocationList=1-1;Equals=1-1,2-2;GetHashCode=0-0;GetInvocationList=0-0;GetObjectData=2-2;GetType=0-0;Invoke=1-1;ReferenceEquals=2-2;Remove=2-2;RemoveAll=2-2;ToString=0-0',
  'System.DateTime':
    '.ctor=1-1,2-2,2-2,3-3,3-3,4-4,9-9,6-6,7-7,7-7,7-7,8-8,8-8,8-8,9-9,9-9,10-10;Add=1-1;AddDays=1-1;AddHours=1-1;AddMicroseconds=1-1;AddMilliseconds=1-1;AddMinutes=1-1;AddMonths=1-1;AddSeconds=1-1;AddTicks=1-1;AddYears=1-1;Compare=2-2;CompareTo=1-1,1-1;DaysInMonth=2-2;Deconstruct=2-2,3-3;Equals=1-1,1-1,2-2,2-2;FromBinary=1-1;FromFileTime=1-1;FromFileTimeUtc=1-1;FromOADate=1-1;GetDateTimeFormats=0-0,1-1,1-1,2-2;GetHashCode=0-0;GetType=0-0;GetTypeCode=0-0;IsDaylightSavingTime=0-0;IsLeapYear=1-1;Parse=1-1,2-2,3-3,1-3,2-2;ParseExact=3-3,4-4,3-4,4-4,3-4;ReferenceEquals=2-2;SpecifyKind=2-2;Subtract=1-1,1-1;ToBinary=0-0;ToFileTime=0-0;ToFileTimeUtc=0-0;ToLocalTime=0-0;ToLongDateString=0-0;ToLongTimeString=0-0;ToOADate=0-0;ToShortDateString=0-0;ToShortTimeString=0-0;ToString=0-0,1-1,1-1,2-2;ToUniversalTime=0-0;TryFormat=2-4,2-4;TryParse=2-2,2-2,4-4,4-4,3-3,3-3;TryParseExact=5-5,5-5,5-5,5-5',
  'System.DayOfWeek':
    'CompareTo=1-1;Equals=1-1,2-2;Format=3-3;GetHashCode=0-0;GetName=1-1,2-2;GetNames=0-0,1-1;GetType=0-0;GetTypeCode=0-0;GetUnderlyingType=1-1;GetValues=0-0,1-1;GetValuesAsUnderlyingType=0-0,1-1;HasFlag=1-1;IsDefined=1-1,2-2;Parse=2-2,2-2,3-3,3-3,1-1,1-1,2-2,2-2;ReferenceEquals=2-2;ToObject=2-2,2-2,2-2,2-2,2-2,2-2,2-2,2-2,2-2;ToString=0-0,1-1,1-1,2-2;TryFormat=3-4;TryParse=3-3,3-3,4-4,4-4,2-2,2-2,3-3,3-3',
  'System.Decimal':
    '.ctor=1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,5-5;Abs=1-1;Add=2-2;Ceiling=1-1;Clamp=3-3;Compare=2-2;CompareTo=1-1,1-1;ConvertToInteger=1-1;ConvertToIntegerNative=1-1;CopySign=2-2;CreateChecked=1-1;CreateSaturating=1-1;CreateTruncating=1-1;Divide=2-2;Equals=1-1,1-1,2-2,2-2;Floor=1-1;FromOACurrency=1-1;GetBits=1-1,2-2;GetHashCode=0-0;GetType=0-0;GetTypeCode=0-0;IsCanonical=1-1;IsEvenInteger=1-1;IsInteger=1-1;IsNegative=1-1;IsOddInteger=1-1;IsPositive=1-1;Max=2-2;MaxMagnitude=2-2;Min=2-2;MinMagnitude=2-2;Multiply=2-2;Negate=1-1;Parse=1-1,2-2,2-2,3-3,1-3,2-2,1-3,2-2;ReferenceEquals=2-2;Remainder=2-2;Round=1-1,2-2,2-2,3-3;Sign=1-1;Subtract=2-2;ToByte=1-1;ToDouble=1-1;ToInt16=1-1;ToInt32=1-1;ToInt64=1-1;ToOACurrency=1-1;ToSByte=1-1;ToSingle=1-1;ToString=0-0,1-1,1-1,2-2;ToUInt16=1-1;ToUInt32=1-1;ToUInt64=1-1;Truncate=1-1;TryFormat=2-4,2-4;TryGetBits=3-3;TryParse=2-2,2-2,2-2,4-4,4-4,3-3,3-3,4-4,3-3',
  'System.Delegate':
    'Clone=0-0;Combine=2-2,0+,1-1;CreateDelegate=5-5,5-5,3-3,4-4,3-3,2-2,3-3,4-4,3-3,4-4;DynamicInvoke=0+;EnumerateInvocationList=1-1;Equals=1-1,2-2;GetHashCode=0-0;GetInvocationList=0-0;GetObjectData=2-2;GetType=0-0;ReferenceEquals=2-2;Remove=2-2;RemoveAll=2-2;ToString=0-0',
  'System.DivideByZeroException':
    '.ctor=0-0,1-1,2-2;Equals=1-1,2-2;GetBaseException=0-0;GetHashCode=0-0;GetObjectData=2-2;GetType=0-0,0-0;ReferenceEquals=2-2;ToString=0-0',
  'System.Double':
    'Abs=1-1;Acos=1-1;AcosPi=1-1;Acosh=1-1;Asin=1-1;AsinPi=1-1;Asinh=1-1;Atan=1-1;Atan2=2-2;Atan2Pi=2-2;AtanPi=1-1;Atanh=1-1;BitDecrement=1-1;BitIncrement=1-1;Cbrt=1-1;Ceiling=1-1;Clamp=3-3;ClampNative=3-3;CompareTo=1-1,1-1;ConvertToInteger=1-1;ConvertToIntegerNative=1-1;CopySign=2-2;Cos=1-1;CosPi=1-1;Cosh=1-1;CreateChecked=1-1;CreateSaturating=1-1;CreateTruncating=1-1;DegreesToRadians=1-1;Equals=1-1,1-1,2-2;Exp=1-1;Exp10=1-1;Exp10M1=1-1;Exp2=1-1;Exp2M1=1-1;ExpM1=1-1;Floor=1-1;FusedMultiplyAdd=3-3;GetHashCode=0-0;GetType=0-0;GetTypeCode=0-0;Hypot=2-2;ILogB=1-1;Ieee754Remainder=2-2;IsEvenInteger=1-1;IsFinite=1-1;IsInfinity=1-1;IsInteger=1-1;IsNaN=1-1;IsNegative=1-1;IsNegativeInfinity=1-1;IsNormal=1-1;IsOddInteger=1-1;IsPositive=1-1;IsPositiveInfinity=1-1;IsPow2=1-1;IsRealNumber=1-1;IsSubnormal=1-1;Lerp=3-3;Log=1-1,2-2;Log10=1-1;Log10P1=1-1;Log2=1-1;Log2P1=1-1;LogP1=1-1;Max=2-2;MaxMagnitude=2-2;MaxMagnitudeNumber=2-2;MaxNative=2-2;MaxNumber=2-2;Min=2-2;MinMagnitude=2-2;MinMagnitudeNumber=2-2;MinNative=2-2;MinNumber=2-2;MultiplyAddEstimate=3-3;Parse=1-1,2-2,2-2,3-3,1-3,2-2,1-3,2-2;Pow=2-2;RadiansToDegrees=1-1;ReciprocalEstimate=1-1;ReciprocalSqrtEstimate=1-1;ReferenceEquals=2-2;RootN=2-2;Round=1-1,2-2,2-2,3-3;ScaleB=2-2;Sign=1-1;Sin=1-1;SinCos=1-1;SinCosPi=1-1;SinPi=1-1;Sinh=1-1;Sqrt=1-1;Tan=1-1;TanPi=1-1;Tanh=1-1;ToString=0-0,1-1,1-1,2-2;Truncate=1-1;TryFormat=2-4,2-4;TryParse=2-2,2-2,2-2,4-4,4-4,3-3,3-3,4-4,3-3',
  'System.EntryPointNotFoundException':
    '.ctor=0-0,1-1,2-2;Equals=1-1,2-2;GetBaseException=0-0;GetHashCode=0-0;GetObjectData=2-2;GetType=0-0,0-0;ReferenceEquals=2-2;ToString=0-0',
  'System.Enum':
    'CompareTo=1-1;Equals=1-1,2-2;Format=3-3;GetHashCode=0-0;GetName=1-1,2-2;GetNames=0-0,1-1;GetType=0-0;GetTypeCode=0-0;GetUnderlyingType=1-1;GetValues=0-0,1-1;GetValuesAsUnderlyingType=0-0,1-1;HasFlag=1-1;IsDefined=1-1,2-2;Parse=2-2,2-2,3-3,3-3,1-1,1-1,2-2,2-2;ReferenceEquals=2-2;ToObject=2-2,2-2,2-2,2-2,2-2,2-2,2-2,2-2,2-2;ToString=0-0,1-1,1-1,2-2;TryFormat=3-4;TryParse=3-3,3-3,4-4,4-4,2-2,2-2,3-3,3-3',
  'System.Environment':
    'Equals=1-1,2-2;Exit=1-1;ExpandEnvironmentVariables=1-1;FailFast=1-1,2-2;GetCommandLineArgs=0-0;GetEnvironmentVariable=1-1,2-2;GetEnvironmentVariables=1-1,0-0;GetFolderPath=1-1,2-2;GetHashCode=0-0;GetLogicalDrives=0-0;GetType=0-0;ReferenceEquals=2-2;SetEnvironmentVariable=2-2,3-3;ToString=0-0',
  'System.EventArgs': '.ctor=0-0;Equals=1-1,2-2;GetHashCode=0-0;GetType=0-0;ReferenceEquals=2-2;ToString=0-0',
  'System.EventHandler':
    '.ctor=2-2;BeginInvoke=4-4;Clone=0-0;Combine=2-2,0+,1-1;CreateDelegate=5-5,5-5,3-3,4-4,3-3,2-2,3-3,4-4,3-3,4-4;DynamicInvoke=0+;EndInvoke=1-1;EnumerateInvocationList=1-1;Equals=1-1,2-2;GetHashCode=0-0;GetInvocationList=0-0;GetObjectData=2-2;GetType=0-0;Invoke=2-2;ReferenceEquals=2-2;Remove=2-2;RemoveAll=2-2;ToString=0-0',
  'System.EventHandler`1':
    '.ctor=2-2;BeginInvoke=4-4;Clone=0-0;Combine=2-2,0+,1-1;CreateDelegate=5-5,5-5,3-3,4-4,3-3,2-2,3-3,4-4,3-3,4-4;DynamicInvoke=0+;EndInvoke=1-1;EnumerateInvocationList=1-1;Equals=1-1,2-2;GetHashCode=0-0;GetInvocationList=0-0;GetObjectData=2-2;GetType=0-0;Invoke=2-2;ReferenceEquals=2-2;Remove=2-2;RemoveAll=2-2;ToString=0-0',
  'System.Exception':
    '.ctor=0-0,1-1,2-2;Equals=1-1,2-2;GetBaseException=0-0;GetHashCode=0-0;GetObjectData=2-2;GetType=0-0,0-0;ReferenceEquals=2-2;ToString=0-0',
  'System.FormatException':
    '.ctor=0-0,1-1,2-2;Equals=1-1,2-2;GetBaseException=0-0;GetHashCode=0-0;GetObjectData=2-2;GetType=0-0,0-0;ReferenceEquals=2-2;ToString=0-0',
  'System.Func`1':
    '.ctor=2-2;BeginInvoke=2-2;Clone=0-0;Combine=2-2,0+,1-1;CreateDelegate=5-5,5-5,3-3,4-4,3-3,2-2,3-3,4-4,3-3,4-4;DynamicInvoke=0+;EndInvoke=1-1;EnumerateInvocationList=1-1;Equals=1-1,2-2;GetHashCode=0-0;GetInvocationList=0-0;GetObjectData=2-2;GetType=0-0;Invoke=0-0;ReferenceEquals=2-2;Remove=2-2;RemoveAll=2-2;ToString=0-0',
  'System.Func`2':
    '.ctor=2-2;BeginInvoke=3-3;Clone=0-0;Combine=2-2,0+,1-1;CreateDelegate=5-5,5-5,3-3,4-4,3-3,2-2,3-3,4-4,3-3,4-4;DynamicInvoke=0+;EndInvoke=1-1;EnumerateInvocationList=1-1;Equals=1-1,2-2;GetHashCode=0-0;GetInvocationList=0-0;GetObjectData=2-2;GetType=0-0;Invoke=1-1;ReferenceEquals=2-2;Remove=2-2;RemoveAll=2-2;ToString=0-0',
  'System.Func`3':
    '.ctor=2-2;BeginInvoke=4-4;Clone=0-0;Combine=2-2,0+,1-1;CreateDelegate=5-5,5-5,3-3,4-4,3-3,2-2,3-3,4-4,3-3,4-4;DynamicInvoke=0+;EndInvoke=1-1;EnumerateInvocationList=1-1;Equals=1-1,2-2;GetHashCode=0-0;GetInvocationList=0-0;GetObjectData=2-2;GetType=0-0;Invoke=2-2;ReferenceEquals=2-2;Remove=2-2;RemoveAll=2-2;ToString=0-0',
  'System.Func`4':
    '.ctor=2-2;BeginInvoke=5-5;Clone=0-0;Combine=2-2,0+,1-1;CreateDelegate=5-5,5-5,3-3,4-4,3-3,2-2,3-3,4-4,3-3,4-4;DynamicInvoke=0+;EndInvoke=1-1;EnumerateInvocationList=1-1;Equals=1-1,2-2;GetHashCode=0-0;GetInvocationList=0-0;GetObjectData=2-2;GetType=0-0;Invoke=3-3;ReferenceEquals=2-2;Remove=2-2;RemoveAll=2-2;ToString=0-0',
  'System.Func`5':
    '.ctor=2-2;BeginInvoke=6-6;Clone=0-0;Combine=2-2,0+,1-1;CreateDelegate=5-5,5-5,3-3,4-4,3-3,2-2,3-3,4-4,3-3,4-4;DynamicInvoke=0+;EndInvoke=1-1;EnumerateInvocationList=1-1;Equals=1-1,2-2;GetHashCode=0-0;GetInvocationList=0-0;GetObjectData=2-2;GetType=0-0;Invoke=4-4;ReferenceEquals=2-2;Remove=2-2;RemoveAll=2-2;ToString=0-0',
  'System.Func`6':
    '.ctor=2-2;BeginInvoke=7-7;Clone=0-0;Combine=2-2,0+,1-1;CreateDelegate=5-5,5-5,3-3,4-4,3-3,2-2,3-3,4-4,3-3,4-4;DynamicInvoke=0+;EndInvoke=1-1;EnumerateInvocationList=1-1;Equals=1-1,2-2;GetHashCode=0-0;GetInvocationList=0-0;GetObjectData=2-2;GetType=0-0;Invoke=5-5;ReferenceEquals=2-2;Remove=2-2;RemoveAll=2-2;ToString=0-0',
  'System.Func`7':
    '.ctor=2-2;BeginInvoke=8-8;Clone=0-0;Combine=2-2,0+,1-1;CreateDelegate=5-5,5-5,3-3,4-4,3-3,2-2,3-3,4-4,3-3,4-4;DynamicInvoke=0+;EndInvoke=1-1;EnumerateInvocationList=1-1;Equals=1-1,2-2;GetHashCode=0-0;GetInvocationList=0-0;GetObjectData=2-2;GetType=0-0;Invoke=6-6;ReferenceEquals=2-2;Remove=2-2;RemoveAll=2-2;ToString=0-0',
  'System.HashCode':
    'Add=1-1,2-2;AddBytes=1-1;Combine=1-1,2-2,3-3,4-4,5-5,6-6,7-7,8-8;Equals=1-1,2-2;GetHashCode=0-0;GetType=0-0;ReferenceEquals=2-2;ToHashCode=0-0;ToString=0-0',
  'System.ICloneable': 'Clone=0-0',
  'System.IComparable': 'CompareTo=1-1',
  'System.IComparable`1': 'CompareTo=1-1',
  'System.IDisposable': 'Dispose=0-0',
  'System.IEquatable`1': 'Equals=1-1',
  'System.IFormatProvider': 'GetFormat=1-1',
  'System.IFormattable': 'ToString=2-2',
  'System.IO.TextReader':
    'Close=0-0;Dispose=0-0;Equals=1-1,2-2;GetHashCode=0-0;GetLifetimeService=0-0;GetType=0-0;InitializeLifetimeService=0-0;Peek=0-0;Read=0-0,3-3,1-1;ReadAsync=3-3,1-2;ReadBlock=3-3,1-1;ReadBlockAsync=3-3,1-2;ReadLine=0-0;ReadLineAsync=0-0,1-1;ReadToEnd=0-0;ReadToEndAsync=0-0,1-1;ReferenceEquals=2-2;Synchronized=1-1;ToString=0-0',
  'System.IO.TextWriter':
    'Close=0-0;CreateBroadcasting=0+;Dispose=0-0;DisposeAsync=0-0;Equals=1-1,2-2;Flush=0-0;FlushAsync=0-0,1-1;GetHashCode=0-0;GetLifetimeService=0-0;GetType=0-0;InitializeLifetimeService=0-0;ReferenceEquals=2-2;Synchronized=1-1;ToString=0-0;Write=1-1,1-1,3-3,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,2-2,3-3,4-4,1+,2-2;WriteAsync=1-1,1-1,1-2,1-1,3-3,1-2;WriteLine=0-0,1-1,1-1,3-3,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,2-2,3-3,4-4,1+,2-2;WriteLineAsync=1-1,1-1,1-2,1-1,3-3,1-2,0-0',
  'System.IndexOutOfRangeException':
    '.ctor=0-0,1-1,2-2;Equals=1-1,2-2;GetBaseException=0-0;GetHashCode=0-0;GetObjectData=2-2;GetType=0-0,0-0;ReferenceEquals=2-2;ToString=0-0',
  'System.InsufficientExecutionStackException':
    '.ctor=0-0,1-1,2-2;Equals=1-1,2-2;GetBaseException=0-0;GetHashCode=0-0;GetObjectData=2-2;GetType=0-0,0-0;ReferenceEquals=2-2;ToString=0-0',
  'System.Int16':
    'Abs=1-1;Clamp=3-3;CompareTo=1-1,1-1;CopySign=2-2;CreateChecked=1-1;CreateSaturating=1-1;CreateTruncating=1-1;DivRem=2-2;Equals=1-1,1-1,2-2;GetHashCode=0-0;GetType=0-0;GetTypeCode=0-0;IsEvenInteger=1-1;IsNegative=1-1;IsOddInteger=1-1;IsPositive=1-1;IsPow2=1-1;LeadingZeroCount=1-1;Log2=1-1;Max=2-2;MaxMagnitude=2-2;Min=2-2;MinMagnitude=2-2;Parse=1-1,2-2,2-2,3-3,1-3,2-2,1-3,2-2;PopCount=1-1;ReferenceEquals=2-2;RotateLeft=2-2;RotateRight=2-2;Sign=1-1;ToString=0-0,1-1,1-1,2-2;TrailingZeroCount=1-1;TryFormat=2-4,2-4;TryParse=2-2,2-2,2-2,4-4,4-4,3-3,3-3,4-4,3-3',
  'System.Int32':
    'Abs=1-1;BigMul=2-2;Clamp=3-3;CompareTo=1-1,1-1;CopySign=2-2;CreateChecked=1-1;CreateSaturating=1-1;CreateTruncating=1-1;DivRem=2-2;Equals=1-1,1-1,2-2;GetHashCode=0-0;GetType=0-0;GetTypeCode=0-0;IsEvenInteger=1-1;IsNegative=1-1;IsOddInteger=1-1;IsPositive=1-1;IsPow2=1-1;LeadingZeroCount=1-1;Log2=1-1;Max=2-2;MaxMagnitude=2-2;Min=2-2;MinMagnitude=2-2;Parse=1-1,2-2,2-2,3-3,1-3,2-2,1-3,2-2;PopCount=1-1;ReferenceEquals=2-2;RotateLeft=2-2;RotateRight=2-2;Sign=1-1;ToString=0-0,1-1,1-1,2-2;TrailingZeroCount=1-1;TryFormat=2-4,2-4;TryParse=2-2,2-2,2-2,4-4,4-4,3-3,3-3,4-4,3-3',
  'System.Int64':
    'Abs=1-1;BigMul=2-2;Clamp=3-3;CompareTo=1-1,1-1;CopySign=2-2;CreateChecked=1-1;CreateSaturating=1-1;CreateTruncating=1-1;DivRem=2-2;Equals=1-1,1-1,2-2;GetHashCode=0-0;GetType=0-0;GetTypeCode=0-0;IsEvenInteger=1-1;IsNegative=1-1;IsOddInteger=1-1;IsPositive=1-1;IsPow2=1-1;LeadingZeroCount=1-1;Log2=1-1;Max=2-2;MaxMagnitude=2-2;Min=2-2;MinMagnitude=2-2;Parse=1-1,2-2,2-2,3-3,1-3,2-2,1-3,2-2;PopCount=1-1;ReferenceEquals=2-2;RotateLeft=2-2;RotateRight=2-2;Sign=1-1;ToString=0-0,1-1,1-1,2-2;TrailingZeroCount=1-1;TryFormat=2-4,2-4;TryParse=2-2,2-2,2-2,4-4,4-4,3-3,3-3,4-4,3-3',
  'System.InvalidCastException':
    '.ctor=0-0,1-1,2-2,2-2;Equals=1-1,2-2;GetBaseException=0-0;GetHashCode=0-0;GetObjectData=2-2;GetType=0-0,0-0;ReferenceEquals=2-2;ToString=0-0',
  'System.InvalidOperationException':
    '.ctor=0-0,1-1,2-2;Equals=1-1,2-2;GetBaseException=0-0;GetHashCode=0-0;GetObjectData=2-2;GetType=0-0,0-0;ReferenceEquals=2-2;ToString=0-0',
  'System.Linq.Enumerable':
    'Aggregate=2-2,3-3,4-4;AggregateBy=4-5,4-5;All=2-2;Any=1-1,2-2;Append=2-2;AsEnumerable=1-1;Average=1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,2-2,2-2,2-2,2-2,2-2,2-2,2-2,2-2,2-2,2-2;Cast=1-1;Chunk=2-2;Concat=2-2;Contains=2-2,3-3;Count=1-1,2-2;CountBy=2-3;DefaultIfEmpty=1-1,2-2;Distinct=1-1,2-2;DistinctBy=2-2,3-3;ElementAt=2-2,2-2;ElementAtOrDefault=2-2,2-2;Empty=0-0;Equals=1-1,2-2;Except=2-2,3-3;ExceptBy=3-3,4-4;First=1-1,2-2;FirstOrDefault=1-1,2-2,2-2,3-3;GetHashCode=0-0;GetType=0-0;GroupBy=2-2,3-3,3-3,4-4,3-3,4-4,4-4,5-5;GroupJoin=5-5,6-6;Index=1-1;InfiniteSequence=2-2;Intersect=2-2,3-3;IntersectBy=3-3,4-4;Join=5-5,6-6;Last=1-1,2-2;LastOrDefault=1-1,2-2,2-2,3-3;LeftJoin=5-5,6-6;LongCount=1-1,2-2;Max=1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,2-2,2-2,2-2,2-2,2-2,2-2,2-2,2-2,2-2,2-2,2-2,2-2;MaxBy=2-2,3-3;Min=1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,2-2,2-2,2-2,2-2,2-2,2-2,2-2,2-2,2-2,2-2,2-2,2-2;MinBy=2-2,3-3;OfType=1-1;Order=1-1,2-2;OrderBy=2-2,3-3;OrderByDescending=2-2,3-3;OrderDescending=1-1,2-2;Prepend=2-2;Range=2-2;ReferenceEquals=2-2;Repeat=2-2;Reverse=1-1,1-1;RightJoin=5-5,6-6;Select=2-2,2-2;SelectMany=2-2,2-2,3-3,3-3;Sequence=3-3;SequenceEqual=2-2,3-3;Shuffle=1-1;Single=1-1,2-2;SingleOrDefault=1-1,2-2,2-2,3-3;Skip=2-2;SkipLast=2-2;SkipWhile=2-2,2-2;Sum=1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,2-2,2-2,2-2,2-2,2-2,2-2,2-2,2-2,2-2,2-2;Take=2-2,2-2;TakeLast=2-2;TakeWhile=2-2,2-2;ThenBy=2-2,3-3;ThenByDescending=2-2,3-3;ToArray=1-1;ToDictionary=1-1,2-2,1-1,2-2,2-2,3-3,3-3,4-4;ToHashSet=1-1,2-2;ToList=1-1;ToLookup=2-2,3-3,3-3,4-4;ToString=0-0;TryGetNonEnumeratedCount=2-2;Union=2-2,3-3;UnionBy=3-3,4-4;Where=2-2,2-2;Zip=3-3,2-2,3-3',
  'System.Linq.IGrouping`2': '',
  'System.Linq.ILookup`2': 'Contains=1-1',
  'System.Linq.IOrderedEnumerable`1': 'CreateOrderedEnumerable=3-3',
  'System.Math':
    'Abs=1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1;Acos=1-1;Acosh=1-1;Asin=1-1;Asinh=1-1;Atan=1-1;Atan2=2-2;Atanh=1-1;BigMul=2-2,2-2,3-3,3-3,2-2,2-2;BitDecrement=1-1;BitIncrement=1-1;Cbrt=1-1;Ceiling=1-1,1-1;Clamp=3-3,3-3,3-3,3-3,3-3,3-3,3-3,3-3,3-3,3-3,3-3,3-3,3-3;CopySign=2-2;Cos=1-1;Cosh=1-1;DivRem=3-3,3-3,2-2,2-2,2-2,2-2,2-2,2-2,2-2,2-2,2-2,2-2;Equals=1-1,2-2;Exp=1-1;Floor=1-1,1-1;FusedMultiplyAdd=3-3;GetHashCode=0-0;GetType=0-0;IEEERemainder=2-2;ILogB=1-1;Log=1-1,2-2;Log10=1-1;Log2=1-1;Max=2-2,2-2,2-2,2-2,2-2,2-2,2-2,2-2,2-2,2-2,2-2,2-2,2-2;MaxMagnitude=2-2;Min=2-2,2-2,2-2,2-2,2-2,2-2,2-2,2-2,2-2,2-2,2-2,2-2,2-2;MinMagnitude=2-2;Pow=2-2;ReciprocalEstimate=1-1;ReciprocalSqrtEstimate=1-1;ReferenceEquals=2-2;Round=1-1,2-2,2-2,3-3,1-1,2-2,2-2,3-3;ScaleB=2-2;Sign=1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1;Sin=1-1;SinCos=1-1;Sinh=1-1;Sqrt=1-1;Tan=1-1;Tanh=1-1;ToString=0-0;Truncate=1-1,1-1',
  'System.MidpointRounding':
    'CompareTo=1-1;Equals=1-1,2-2;Format=3-3;GetHashCode=0-0;GetName=1-1,2-2;GetNames=0-0,1-1;GetType=0-0;GetTypeCode=0-0;GetUnderlyingType=1-1;GetValues=0-0,1-1;GetValuesAsUnderlyingType=0-0,1-1;HasFlag=1-1;IsDefined=1-1,2-2;Parse=2-2,2-2,3-3,3-3,1-1,1-1,2-2,2-2;ReferenceEquals=2-2;ToObject=2-2,2-2,2-2,2-2,2-2,2-2,2-2,2-2,2-2;ToString=0-0,1-1,1-1,2-2;TryFormat=3-4;TryParse=3-3,3-3,4-4,4-4,2-2,2-2,3-3,3-3',
  'System.MulticastDelegate':
    'Clone=0-0;Combine=2-2,0+,1-1;CreateDelegate=5-5,5-5,3-3,4-4,3-3,2-2,3-3,4-4,3-3,4-4;DynamicInvoke=0+;EnumerateInvocationList=1-1;Equals=1-1,2-2;GetHashCode=0-0;GetInvocationList=0-0;GetObjectData=2-2;GetType=0-0;ReferenceEquals=2-2;Remove=2-2;RemoveAll=2-2;ToString=0-0',
  'System.NotFiniteNumberException':
    '.ctor=0-0,1-1,1-1,2-2,2-2,3-3;Equals=1-1,2-2;GetBaseException=0-0;GetHashCode=0-0;GetObjectData=2-2;GetType=0-0,0-0;ReferenceEquals=2-2;ToString=0-0',
  'System.NotImplementedException':
    '.ctor=0-0,1-1,2-2;Equals=1-1,2-2;GetBaseException=0-0;GetHashCode=0-0;GetObjectData=2-2;GetType=0-0,0-0;ReferenceEquals=2-2;ToString=0-0',
  'System.NotSupportedException':
    '.ctor=0-0,1-1,2-2;Equals=1-1,2-2;GetBaseException=0-0;GetHashCode=0-0;GetObjectData=2-2;GetType=0-0,0-0;ReferenceEquals=2-2;ToString=0-0',
  'System.NullReferenceException':
    '.ctor=0-0,1-1,2-2;Equals=1-1,2-2;GetBaseException=0-0;GetHashCode=0-0;GetObjectData=2-2;GetType=0-0,0-0;ReferenceEquals=2-2;ToString=0-0',
  'System.Nullable`1':
    '.ctor=1-1;Equals=1-1,2-2;GetHashCode=0-0;GetType=0-0;GetValueOrDefault=0-0,1-1;ReferenceEquals=2-2;ToString=0-0',
  'System.Object': '.ctor=0-0;Equals=1-1,2-2;GetHashCode=0-0;GetType=0-0;ReferenceEquals=2-2;ToString=0-0',
  'System.ObjectDisposedException':
    '.ctor=1-1,2-2,2-2;Equals=1-1,2-2;GetBaseException=0-0;GetHashCode=0-0;GetObjectData=2-2;GetType=0-0,0-0;ReferenceEquals=2-2;ThrowIf=2-2,2-2;ToString=0-0',
  'System.OutOfMemoryException':
    '.ctor=0-0,1-1,2-2;Equals=1-1,2-2;GetBaseException=0-0;GetHashCode=0-0;GetObjectData=2-2;GetType=0-0,0-0;ReferenceEquals=2-2;ToString=0-0',
  'System.OverflowException':
    '.ctor=0-0,1-1,2-2;Equals=1-1,2-2;GetBaseException=0-0;GetHashCode=0-0;GetObjectData=2-2;GetType=0-0,0-0;ReferenceEquals=2-2;ToString=0-0',
  'System.PlatformNotSupportedException':
    '.ctor=0-0,1-1,2-2;Equals=1-1,2-2;GetBaseException=0-0;GetHashCode=0-0;GetObjectData=2-2;GetType=0-0,0-0;ReferenceEquals=2-2;ToString=0-0',
  'System.Predicate`1':
    '.ctor=2-2;BeginInvoke=3-3;Clone=0-0;Combine=2-2,0+,1-1;CreateDelegate=5-5,5-5,3-3,4-4,3-3,2-2,3-3,4-4,3-3,4-4;DynamicInvoke=0+;EndInvoke=1-1;EnumerateInvocationList=1-1;Equals=1-1,2-2;GetHashCode=0-0;GetInvocationList=0-0;GetObjectData=2-2;GetType=0-0;Invoke=1-1;ReferenceEquals=2-2;Remove=2-2;RemoveAll=2-2;ToString=0-0',
  'System.Random':
    '.ctor=0-0,1-1;Equals=1-1,2-2;GetHashCode=0-0;GetHexString=1-2,1-2;GetItems=2-2,2-2,2-2;GetString=2-2;GetType=0-0;Next=0-0,1-1,2-2;NextBytes=1-1,1-1;NextDouble=0-0;NextInt64=0-0,1-1,2-2;NextSingle=0-0;ReferenceEquals=2-2;Shuffle=1-1,1-1;ToString=0-0',
  'System.RankException':
    '.ctor=0-0,1-1,2-2;Equals=1-1,2-2;GetBaseException=0-0;GetHashCode=0-0;GetObjectData=2-2;GetType=0-0,0-0;ReferenceEquals=2-2;ToString=0-0',
  'System.Runtime.CompilerServices.SwitchExpressionException':
    '.ctor=0-0,1-1,1-1,1-1,2-2;Equals=1-1,2-2;GetBaseException=0-0;GetHashCode=0-0;GetObjectData=2-2;GetType=0-0,0-0;ReferenceEquals=2-2;ToString=0-0',
  'System.SByte':
    'Abs=1-1;Clamp=3-3;CompareTo=1-1,1-1;CopySign=2-2;CreateChecked=1-1;CreateSaturating=1-1;CreateTruncating=1-1;DivRem=2-2;Equals=1-1,1-1,2-2;GetHashCode=0-0;GetType=0-0;GetTypeCode=0-0;IsEvenInteger=1-1;IsNegative=1-1;IsOddInteger=1-1;IsPositive=1-1;IsPow2=1-1;LeadingZeroCount=1-1;Log2=1-1;Max=2-2;MaxMagnitude=2-2;Min=2-2;MinMagnitude=2-2;Parse=1-1,2-2,2-2,3-3,1-3,2-2,1-3,2-2;PopCount=1-1;ReferenceEquals=2-2;RotateLeft=2-2;RotateRight=2-2;Sign=1-1;ToString=0-0,1-1,1-1,2-2;TrailingZeroCount=1-1;TryFormat=2-4,2-4;TryParse=2-2,2-2,2-2,4-4,4-4,3-3,3-3,4-4,3-3',
  'System.Single':
    'Abs=1-1;Acos=1-1;AcosPi=1-1;Acosh=1-1;Asin=1-1;AsinPi=1-1;Asinh=1-1;Atan=1-1;Atan2=2-2;Atan2Pi=2-2;AtanPi=1-1;Atanh=1-1;BitDecrement=1-1;BitIncrement=1-1;Cbrt=1-1;Ceiling=1-1;Clamp=3-3;ClampNative=3-3;CompareTo=1-1,1-1;ConvertToInteger=1-1;ConvertToIntegerNative=1-1;CopySign=2-2;Cos=1-1;CosPi=1-1;Cosh=1-1;CreateChecked=1-1;CreateSaturating=1-1;CreateTruncating=1-1;DegreesToRadians=1-1;Equals=1-1,1-1,2-2;Exp=1-1;Exp10=1-1;Exp10M1=1-1;Exp2=1-1;Exp2M1=1-1;ExpM1=1-1;Floor=1-1;FusedMultiplyAdd=3-3;GetHashCode=0-0;GetType=0-0;GetTypeCode=0-0;Hypot=2-2;ILogB=1-1;Ieee754Remainder=2-2;IsEvenInteger=1-1;IsFinite=1-1;IsInfinity=1-1;IsInteger=1-1;IsNaN=1-1;IsNegative=1-1;IsNegativeInfinity=1-1;IsNormal=1-1;IsOddInteger=1-1;IsPositive=1-1;IsPositiveInfinity=1-1;IsPow2=1-1;IsRealNumber=1-1;IsSubnormal=1-1;Lerp=3-3;Log=1-1,2-2;Log10=1-1;Log10P1=1-1;Log2=1-1;Log2P1=1-1;LogP1=1-1;Max=2-2;MaxMagnitude=2-2;MaxMagnitudeNumber=2-2;MaxNative=2-2;MaxNumber=2-2;Min=2-2;MinMagnitude=2-2;MinMagnitudeNumber=2-2;MinNative=2-2;MinNumber=2-2;MultiplyAddEstimate=3-3;Parse=1-1,2-2,2-2,3-3,1-3,2-2,1-3,2-2;Pow=2-2;RadiansToDegrees=1-1;ReciprocalEstimate=1-1;ReciprocalSqrtEstimate=1-1;ReferenceEquals=2-2;RootN=2-2;Round=1-1,2-2,2-2,3-3;ScaleB=2-2;Sign=1-1;Sin=1-1;SinCos=1-1;SinCosPi=1-1;SinPi=1-1;Sinh=1-1;Sqrt=1-1;Tan=1-1;TanPi=1-1;Tanh=1-1;ToString=0-0,1-1,1-1,2-2;Truncate=1-1;TryFormat=2-4,2-4;TryParse=2-2,2-2,2-2,4-4,4-4,3-3,3-3,4-4,3-3',
  'System.String':
    '.ctor=1-1,3-3,1-1,3-3,1-1,3-3,4-4,2-2,1-1;Clone=0-0;Compare=2-2,3-3,3-3,4-4,4-4,5-5,6-6,7-7,7-7,6-6;CompareOrdinal=2-2,5-5;CompareTo=1-1,1-1;Concat=1-1,2-2,3-3,0+,1-1,1-1,1-1,2-2,3-3,4-4,2-2,3-3,4-4,0+,1-1;Contains=1-1,2-2,1-1,2-2;Copy=1-1;CopyTo=4-4,1-1;Create=3-3,2-2,3-3;EndsWith=1-1,2-2,3-3,1-1;EnumerateRunes=0-0;Equals=1-1,1-1,2-2,2-2,3-3,2-2;Format=2-2,3-3,4-4,1+,2-2,3-3,4-4,5-5,2+,3-3,3-3,4-4,5-5,2+,3-3;GetEnumerator=0-0;GetHashCode=0-0,1-1,1-1,2-2;GetPinnableReference=0-0;GetType=0-0;GetTypeCode=0-0;IndexOf=1-1,2-2,2-2,3-3,1-1,2-2,3-3,2-2,3-3,4-4;IndexOfAny=1-1,2-2,3-3;Insert=2-2;Intern=1-1;IsInterned=1-1;IsNormalized=0-0,1-1;IsNullOrEmpty=1-1;IsNullOrWhiteSpace=1-1;Join=1+,2-2,1+,2-2,4-4,4-4,2-2,1+,2-2,1+,2-2,2-2,2-2;LastIndexOf=1-1,2-2,3-3,1-1,2-2,3-3,2-2,3-3,4-4;LastIndexOfAny=1-1,2-2,3-3;Normalize=0-0,1-1;PadLeft=1-1,2-2;PadRight=1-1,2-2;ReferenceEquals=2-2;Remove=2-2,1-1;Replace=4-4,3-3,2-2,2-2;ReplaceLineEndings=0-0,1-1;Split=1-2,2-3,0+,1-1,2-2,2-2,3-3,1-2,2-3,2-2,3-3;StartsWith=1-1,2-2,3-3,1-1;Substring=1-1,2-2;ToCharArray=0-0,2-2;ToLower=0-0,1-1;ToLowerInvariant=0-0;ToString=0-0,1-1;ToUpper=0-0,1-1;ToUpperInvariant=0-0;Trim=0-0,1-1,0+,1-1;TrimEnd=0-0,1-1,0+,1-1;TrimStart=0-0,1-1,0+,1-1;TryCopyTo=1-1',
  'System.StringComparer':
    'Compare=2-2,2-2;Create=2-2,2-2;Equals=2-2,2-2,1-1,2-2;FromComparison=1-1;GetHashCode=1-1,1-1,0-0;GetType=0-0;IsWellKnownCultureAwareComparer=3-3;IsWellKnownOrdinalComparer=2-2;ReferenceEquals=2-2;ToString=0-0',
  'System.StringComparison':
    'CompareTo=1-1;Equals=1-1,2-2;Format=3-3;GetHashCode=0-0;GetName=1-1,2-2;GetNames=0-0,1-1;GetType=0-0;GetTypeCode=0-0;GetUnderlyingType=1-1;GetValues=0-0,1-1;GetValuesAsUnderlyingType=0-0,1-1;HasFlag=1-1;IsDefined=1-1,2-2;Parse=2-2,2-2,3-3,3-3,1-1,1-1,2-2,2-2;ReferenceEquals=2-2;ToObject=2-2,2-2,2-2,2-2,2-2,2-2,2-2,2-2,2-2;ToString=0-0,1-1,1-1,2-2;TryFormat=3-4;TryParse=3-3,3-3,4-4,4-4,2-2,2-2,3-3,3-3',
  'System.StringSplitOptions':
    'CompareTo=1-1;Equals=1-1,2-2;Format=3-3;GetHashCode=0-0;GetName=1-1,2-2;GetNames=0-0,1-1;GetType=0-0;GetTypeCode=0-0;GetUnderlyingType=1-1;GetValues=0-0,1-1;GetValuesAsUnderlyingType=0-0,1-1;HasFlag=1-1;IsDefined=1-1,2-2;Parse=2-2,2-2,3-3,3-3,1-1,1-1,2-2,2-2;ReferenceEquals=2-2;ToObject=2-2,2-2,2-2,2-2,2-2,2-2,2-2,2-2,2-2;ToString=0-0,1-1,1-1,2-2;TryFormat=3-4;TryParse=3-3,3-3,4-4,4-4,2-2,2-2,3-3,3-3',
  'System.SystemException':
    '.ctor=0-0,1-1,2-2;Equals=1-1,2-2;GetBaseException=0-0;GetHashCode=0-0;GetObjectData=2-2;GetType=0-0,0-0;ReferenceEquals=2-2;ToString=0-0',
  'System.Text.Encoding':
    'Clone=0-0;Convert=3-3,5-5;CreateTranscodingStream=3-4;Equals=1-1,2-2;GetByteCount=1-1,1-1,3-3,3-3,2-2,1-1;GetBytes=1-1,3-3,5-5,1-1,3-3,5-5,4-4,2-2;GetCharCount=1-1,3-3,2-2,1-1;GetChars=1-1,3-3,5-5,4-4,2-2;GetDecoder=0-0;GetEncoder=0-0;GetEncoding=1-1,3-3,1-1,3-3;GetEncodings=0-0;GetHashCode=0-0;GetMaxByteCount=1-1;GetMaxCharCount=1-1;GetPreamble=0-0;GetString=2-2,1-1,1-1,3-3;GetType=0-0;IsAlwaysNormalized=0-0,1-1;ReferenceEquals=2-2;RegisterProvider=1-1;ToString=0-0;TryGetBytes=3-3;TryGetChars=3-3',
  'System.Text.RegularExpressions.Capture':
    'Equals=1-1,2-2;GetHashCode=0-0;GetType=0-0;ReferenceEquals=2-2;ToString=0-0',
  'System.Text.RegularExpressions.Group':
    'Equals=1-1,2-2;GetHashCode=0-0;GetType=0-0;ReferenceEquals=2-2;Synchronized=1-1;ToString=0-0',
  'System.Text.RegularExpressions.GroupCollection':
    'ContainsKey=1-1;CopyTo=2-2,2-2;Equals=1-1,2-2;GetEnumerator=0-0;GetHashCode=0-0;GetType=0-0;ReferenceEquals=2-2;ToString=0-0;TryGetValue=2-2',
  'System.Text.RegularExpressions.Match':
    'Equals=1-1,2-2;GetHashCode=0-0;GetType=0-0;NextMatch=0-0;ReferenceEquals=2-2;Result=1-1;Synchronized=1-1,1-1;ToString=0-0',
  'System.Text.RegularExpressions.MatchCollection':
    'CopyTo=2-2,2-2;Equals=1-1,2-2;GetEnumerator=0-0;GetHashCode=0-0;GetType=0-0;ReferenceEquals=2-2;ToString=0-0',
  'System.Text.RegularExpressions.MatchEvaluator':
    '.ctor=2-2;BeginInvoke=3-3;Clone=0-0;Combine=2-2,0+,1-1;CreateDelegate=5-5,5-5,3-3,4-4,3-3,2-2,3-3,4-4,3-3,4-4;DynamicInvoke=0+;EndInvoke=1-1;EnumerateInvocationList=1-1;Equals=1-1,2-2;GetHashCode=0-0;GetInvocationList=0-0;GetObjectData=2-2;GetType=0-0;Invoke=1-1;ReferenceEquals=2-2;Remove=2-2;RemoveAll=2-2;ToString=0-0',
  'System.Text.RegularExpressions.Regex':
    '.ctor=1-1,2-2,3-3;CompileToAssembly=2-2,3-3,4-4;Count=1-1,1-1,2-2,2-2,3-3,4-4,2-2,3-3,4-4;EnumerateMatches=2-2,3-3,4-4,1-1,2-2;EnumerateSplits=2-2,3-3,4-4,1-1,2-2,3-3;Equals=1-1,2-2;Escape=1-1;GetGroupNames=0-0;GetGroupNumbers=0-0;GetHashCode=0-0;GetType=0-0;GroupNameFromNumber=1-1;GroupNumberFromName=1-1;IsMatch=2-2,2-2,3-3,3-3,4-4,4-4,1-1,2-2,1-1,2-2;Match=2-2,3-3,4-4,1-1,2-2,3-3;Matches=2-2,3-3,4-4,1-1,2-2;ReferenceEquals=2-2;Replace=3-3,4-4,5-5,2-2,3-3,4-4,3-3,4-4,5-5,2-2,3-3,4-4;Split=2-2,3-3,4-4,1-1,2-2,3-3;ToString=0-0;Unescape=1-1',
  'System.Text.RegularExpressions.RegexOptions':
    'CompareTo=1-1;Equals=1-1,2-2;Format=3-3;GetHashCode=0-0;GetName=1-1,2-2;GetNames=0-0,1-1;GetType=0-0;GetTypeCode=0-0;GetUnderlyingType=1-1;GetValues=0-0,1-1;GetValuesAsUnderlyingType=0-0,1-1;HasFlag=1-1;IsDefined=1-1,2-2;Parse=2-2,2-2,3-3,3-3,1-1,1-1,2-2,2-2;ReferenceEquals=2-2;ToObject=2-2,2-2,2-2,2-2,2-2,2-2,2-2,2-2,2-2;ToString=0-0,1-1,1-1,2-2;TryFormat=3-4;TryParse=3-3,3-3,4-4,4-4,2-2,2-2,3-3,3-3',
  'System.Text.RegularExpressions.RegexParseException':
    'Equals=1-1,2-2;GetBaseException=0-0;GetHashCode=0-0;GetObjectData=2-2;GetType=0-0,0-0;ReferenceEquals=2-2;ThrowIfNullOrEmpty=1-2;ThrowIfNullOrWhiteSpace=1-2;ToString=0-0',
  'System.Text.StringBuilder':
    '.ctor=0-0,1-1,1-1,2-2,4-4,2-2;Append=2-2,3-3,1-1,3-3,1-1,3-3,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,2-2,2-2;AppendFormat=2-2,3-3,4-4,1+,2-2,3-3,4-4,5-5,2+,3-3,3-3,4-4,5-5,2+,3-3;AppendJoin=1+,2-2,2-2,1+,2-2,1+,2-2,2-2,1+,2-2;AppendLine=0-0,1-1,1-1,2-2;Clear=0-0;CopyTo=4-4,3-3;EnsureCapacity=1-1;Equals=1-1,1-1,1-1,2-2;GetChunks=0-0;GetHashCode=0-0;GetType=0-0;Insert=3-3,2-2,2-2,2-2,2-2,2-2,2-2,2-2,4-4,2-2,2-2,2-2,2-2,2-2,2-2,2-2,2-2,2-2,2-2;ReferenceEquals=2-2;Remove=2-2;Replace=2-2,2-2,4-4,4-4,2-2,4-4;ToString=0-0,2-2',
  'System.TimeSpan':
    '.ctor=1-1,3-3,4-4,5-5,6-6;Add=1-1;Compare=2-2;CompareTo=1-1,1-1;Divide=1-1,1-1;Duration=0-0;Equals=1-1,1-1,2-2,2-2;FromDays=1-1,1-1,1-6;FromHours=1-1,1-5,1-1;FromMicroseconds=1-1,1-1;FromMilliseconds=1-1,2-2,1-1;FromMinutes=1-1,1-4,1-1;FromSeconds=1-1,1-3,1-1;FromTicks=1-1;GetHashCode=0-0;GetType=0-0;Multiply=1-1;Negate=0-0;Parse=1-1,2-2,1-2;ParseExact=3-3,3-3,4-4,3-4,4-4,3-4;ReferenceEquals=2-2;Subtract=1-1;ToString=0-0,1-1,2-2;TryFormat=2-4,2-4;TryParse=2-2,2-2,3-3,3-3;TryParseExact=4-4,4-4,4-4,4-4,5-5,5-5,5-5,5-5',
  'System.TimeoutException':
    '.ctor=0-0,1-1,2-2;Equals=1-1,2-2;GetBaseException=0-0;GetHashCode=0-0;GetObjectData=2-2;GetType=0-0,0-0;ReferenceEquals=2-2;ToString=0-0',
  'System.Tuple':
    'Create=1-1,2-2,3-3,4-4,5-5,6-6,7-7,8-8;Equals=1-1,2-2;GetHashCode=0-0;GetType=0-0;ReferenceEquals=2-2;ToString=0-0',
  'System.TupleExtensions':
    'Deconstruct=2-2,3-3,4-4,5-5,6-6,7-7,8-8,9-9,10-10,11-11,12-12,13-13,14-14,15-15,16-16,17-17,18-18,19-19,20-20,21-21,22-22;Equals=1-1,2-2;GetHashCode=0-0;GetType=0-0;ReferenceEquals=2-2;ToString=0-0;ToTuple=1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1;ToValueTuple=1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1,1-1',
  'System.Tuple`2': '.ctor=2-2;Equals=1-1,2-2;GetHashCode=0-0;GetType=0-0;ReferenceEquals=2-2;ToString=0-0',
  'System.Tuple`3': '.ctor=3-3;Equals=1-1,2-2;GetHashCode=0-0;GetType=0-0;ReferenceEquals=2-2;ToString=0-0',
  'System.Type':
    'Equals=1-1,1-1,2-2;FindInterfaces=2-2;FindMembers=4-4;GetArrayRank=0-0;GetConstructor=1-1,2-2,4-4,5-5;GetConstructors=0-0,1-1;GetCustomAttributes=1-1,2-2;GetCustomAttributesData=0-0;GetDefaultMembers=0-0;GetElementType=0-0;GetEnumName=1-1;GetEnumNames=0-0;GetEnumUnderlyingType=0-0;GetEnumValues=0-0;GetEnumValuesAsUnderlyingType=0-0;GetEvent=1-1,2-2;GetEvents=0-0,1-1;GetField=1-1,2-2;GetFields=0-0,1-1;GetFunctionPointerCallingConventions=0-0;GetFunctionPointerParameterTypes=0-0;GetFunctionPointerReturnType=0-0;GetGenericArguments=0-0;GetGenericParameterConstraints=0-0;GetGenericTypeDefinition=0-0;GetHashCode=0-0;GetInterface=1-1,2-2;GetInterfaceMap=1-1;GetInterfaces=0-0;GetMember=1-1,2-2,3-3;GetMemberWithSameMetadataDefinitionAs=1-1;GetMembers=0-0,1-1;GetMethod=1-1,2-2,3-3,2-2,3-3,5-5,6-6,3-3,4-4,4-4,6-6,7-7;GetMethods=0-0,1-1;GetNestedType=1-1,2-2;GetNestedTypes=0-0,1-1;GetOptionalCustomModifiers=0-0;GetProperties=0-0,1-1;GetProperty=1-1,2-2,2-2,2-2,3-3,4-4,6-6;GetRequiredCustomModifiers=0-0;GetType=3-3,2-2,1-1,3-3,4-4,5-5,0-0,0-0;GetTypeArray=1-1;GetTypeCode=1-1;GetTypeFromCLSID=1-1,2-2,2-2,3-3;GetTypeFromHandle=1-1;GetTypeFromProgID=1-1,2-2,2-2,3-3;GetTypeHandle=1-1;HasSameMetadataDefinitionAs=1-1;InvokeMember=5-5,6-6,8-8;IsAssignableFrom=1-1;IsAssignableTo=1-1;IsDefined=2-2;IsEnumDefined=1-1;IsEquivalentTo=1-1;IsInstanceOfType=1-1;IsSubclassOf=1-1;MakeArrayType=0-0,1-1;MakeByRefType=0-0;MakeGenericMethodParameter=1-1;MakeGenericSignatureType=1+;MakeGenericType=0+;MakePointerType=0-0;ReferenceEquals=2-2;ReflectionOnlyGetType=3-3;ToString=0-0',
  'System.TypeInitializationException':
    '.ctor=2-2;Equals=1-1,2-2;GetBaseException=0-0;GetHashCode=0-0;GetObjectData=2-2;GetType=0-0,0-0;ReferenceEquals=2-2;ToString=0-0',
  'System.UInt16':
    'Clamp=3-3;CompareTo=1-1,1-1;CreateChecked=1-1;CreateSaturating=1-1;CreateTruncating=1-1;DivRem=2-2;Equals=1-1,1-1,2-2;GetHashCode=0-0;GetType=0-0;GetTypeCode=0-0;IsEvenInteger=1-1;IsOddInteger=1-1;IsPow2=1-1;LeadingZeroCount=1-1;Log2=1-1;Max=2-2;Min=2-2;Parse=1-1,2-2,2-2,3-3,1-3,2-2,1-3,2-2;PopCount=1-1;ReferenceEquals=2-2;RotateLeft=2-2;RotateRight=2-2;Sign=1-1;ToString=0-0,1-1,1-1,2-2;TrailingZeroCount=1-1;TryFormat=2-4,2-4;TryParse=2-2,2-2,2-2,4-4,4-4,3-3,3-3,4-4,3-3',
  'System.UInt32':
    'BigMul=2-2;Clamp=3-3;CompareTo=1-1,1-1;CreateChecked=1-1;CreateSaturating=1-1;CreateTruncating=1-1;DivRem=2-2;Equals=1-1,1-1,2-2;GetHashCode=0-0;GetType=0-0;GetTypeCode=0-0;IsEvenInteger=1-1;IsOddInteger=1-1;IsPow2=1-1;LeadingZeroCount=1-1;Log2=1-1;Max=2-2;Min=2-2;Parse=1-1,2-2,2-2,3-3,1-3,2-2,1-3,2-2;PopCount=1-1;ReferenceEquals=2-2;RotateLeft=2-2;RotateRight=2-2;Sign=1-1;ToString=0-0,1-1,1-1,2-2;TrailingZeroCount=1-1;TryFormat=2-4,2-4;TryParse=2-2,2-2,2-2,4-4,4-4,3-3,3-3,4-4,3-3',
  'System.UInt64':
    'BigMul=2-2;Clamp=3-3;CompareTo=1-1,1-1;CreateChecked=1-1;CreateSaturating=1-1;CreateTruncating=1-1;DivRem=2-2;Equals=1-1,1-1,2-2;GetHashCode=0-0;GetType=0-0;GetTypeCode=0-0;IsEvenInteger=1-1;IsOddInteger=1-1;IsPow2=1-1;LeadingZeroCount=1-1;Log2=1-1;Max=2-2;Min=2-2;Parse=1-1,2-2,2-2,3-3,1-3,2-2,1-3,2-2;PopCount=1-1;ReferenceEquals=2-2;RotateLeft=2-2;RotateRight=2-2;Sign=1-1;ToString=0-0,1-1,1-1,2-2;TrailingZeroCount=1-1;TryFormat=2-4,2-4;TryParse=2-2,2-2,2-2,4-4,4-4,3-3,3-3,4-4,3-3',
  'System.ValueTuple':
    'CompareTo=1-1;Create=0-0,1-1,2-2,3-3,4-4,5-5,6-6,7-7,8-8;Equals=1-1,1-1,2-2;GetHashCode=0-0;GetType=0-0;ReferenceEquals=2-2;ToString=0-0',
  'System.ValueTuple`1':
    '.ctor=1-1;CompareTo=1-1;Equals=1-1,1-1,2-2;GetHashCode=0-0;GetType=0-0;ReferenceEquals=2-2;ToString=0-0',
  'System.ValueTuple`2':
    '.ctor=2-2;CompareTo=1-1;Equals=1-1,1-1,2-2;GetHashCode=0-0;GetType=0-0;ReferenceEquals=2-2;ToString=0-0',
  'System.ValueTuple`3':
    '.ctor=3-3;CompareTo=1-1;Equals=1-1,1-1,2-2;GetHashCode=0-0;GetType=0-0;ReferenceEquals=2-2;ToString=0-0',
  'System.ValueTuple`4':
    '.ctor=4-4;CompareTo=1-1;Equals=1-1,1-1,2-2;GetHashCode=0-0;GetType=0-0;ReferenceEquals=2-2;ToString=0-0',
  'System.ValueTuple`5':
    '.ctor=5-5;CompareTo=1-1;Equals=1-1,1-1,2-2;GetHashCode=0-0;GetType=0-0;ReferenceEquals=2-2;ToString=0-0',
  'System.ValueTuple`6':
    '.ctor=6-6;CompareTo=1-1;Equals=1-1,1-1,2-2;GetHashCode=0-0;GetType=0-0;ReferenceEquals=2-2;ToString=0-0',
  'System.ValueTuple`7':
    '.ctor=7-7;CompareTo=1-1;Equals=1-1,1-1,2-2;GetHashCode=0-0;GetType=0-0;ReferenceEquals=2-2;ToString=0-0',
  'System.ValueTuple`8':
    '.ctor=8-8;CompareTo=1-1;Equals=1-1,1-1,2-2;GetHashCode=0-0;GetType=0-0;ReferenceEquals=2-2;ToString=0-0',
  'System.ValueType': 'Equals=1-1,2-2;GetHashCode=0-0;GetType=0-0;ReferenceEquals=2-2;ToString=0-0',
};
