/**
 * The objects that `dynamic` binds members of as it runs: ExpandoObject, whose members are its entries, and DynamicObject,
 * whose subclasses bind the members they lack through their `Try` methods. The internal indexer and method are what a
 * late-bound member access, assignment, or call of such an object binds to.
 */
export const DYNAMIC_SOURCE = String.raw`
namespace System.Dynamic {
  public interface IDynamicMetaObjectProvider { }
  public abstract class GetMemberBinder {
    public string Name { get; }
    public bool IgnoreCase { get; }
    public Type ReturnType { get; }
  }
  public abstract class SetMemberBinder {
    public string Name { get; }
    public bool IgnoreCase { get; }
    public Type ReturnType { get; }
  }
  public abstract class InvokeMemberBinder {
    public string Name { get; }
    public bool IgnoreCase { get; }
    public Type ReturnType { get; }
    public CallInfo CallInfo { get; }
  }
  public sealed class CallInfo {
    public CallInfo(int argCount, params string[] argNames);
    public int ArgumentCount { get; }
  }
  public class DynamicObject : IDynamicMetaObjectProvider {
    protected DynamicObject();
    public virtual bool TryGetMember(GetMemberBinder binder, out object? result);
    public virtual bool TrySetMember(SetMemberBinder binder, object? value);
    public virtual bool TryInvokeMember(InvokeMemberBinder binder, object?[]? args, out object? result);
    public virtual System.Collections.Generic.IEnumerable<string> GetDynamicMemberNames();
    internal dynamic this[string name, bool isMember] { get; set; }
    internal dynamic InvokeMember(string name, params object?[] args);
  }
  public sealed class ExpandoObject : IDynamicMetaObjectProvider, System.Collections.Generic.IDictionary<string, object?> {
    public ExpandoObject();
    private object? this[string key] { get; set; }
    private System.Collections.Generic.ICollection<string> Keys { get; }
    private System.Collections.Generic.ICollection<object?> Values { get; }
    private int Count { get; }
    private bool IsReadOnly { get; }
    private void Add(string key, object? value);
    private bool ContainsKey(string key);
    private bool Remove(string key);
    private bool TryGetValue(string key, out object? value);
    private void Add(System.Collections.Generic.KeyValuePair<string, object?> item);
    private void Clear();
    private bool Contains(System.Collections.Generic.KeyValuePair<string, object?> item);
    private void CopyTo(System.Collections.Generic.KeyValuePair<string, object?>[] array, int arrayIndex);
    private bool Remove(System.Collections.Generic.KeyValuePair<string, object?> item);
    private System.Collections.Generic.IEnumerator<System.Collections.Generic.KeyValuePair<string, object?>> GetEnumerator();
    internal dynamic this[string name, bool isMember] { get; set; }
  }
}

namespace Microsoft.CSharp.RuntimeBinder {
  public sealed class CSharpGetMemberBinder : System.Dynamic.GetMemberBinder { }
  public sealed class CSharpSetMemberBinder : System.Dynamic.SetMemberBinder { }
  public sealed class CSharpInvokeMemberBinder : System.Dynamic.InvokeMemberBinder { }
}
`;
