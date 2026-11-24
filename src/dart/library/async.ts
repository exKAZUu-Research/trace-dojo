import { STREAM_SOURCE } from './asyncStream';

/** The `wait` getters of records of 2 to 9 futures, which differ only in their arity. */
function futureRecordExtensions(): string {
  let source = '';
  for (let arity = 2; arity <= 9; arity++) {
    const indices = Array.from({ length: arity }, (_, index) => index + 1);
    const list = (format: (index: number) => string, separator = ', '): string => indices.map(format).join(separator);
    const types = list((index) => `T${index}`);
    source += `
extension FutureRecord${arity}<${types}> on (${list((index) => `Future<T${index}>`)}) {
  Future<(${types})> get wait {
    final c = Completer<(${types})>.sync();
${list((index) => `    final v${index} = _FutureResult<T${index}>($${index});`, '\n')}
    _FutureResult._waitAll([${list((index) => `v${index}`)}], (int errors) {
      if (errors == 0) {
        c.complete((${list((index) => `v${index}.value`)}));
      } else {
        c.completeError(ParallelWaitError(
          (${list((index) => `v${index}.valueOrNull`)}),
          (${list((index) => `v${index}.errorOrNull`)}),
          errorCount: errors,
          defaultError: ${list((index) => `v${index}.errorOrNull`, ' ?? ')},
        ));
      }
    });
    return c.future;
  }
}
`;
  }
  return source;
}

/**
 * dart:async as the interpreter declares it: the SDK's futures, streams, and microtask queue transcribed with every
 * zone being the root zone, over native timers. The source must not contain `${`, which the template would
 * interpolate.
 */
export const ASYNC_SOURCE =
  String.raw`
abstract class FutureOr<T> {
  FutureOr._() {
    throw UnsupportedError("FutureOr cannot be instantiated");
  }
}

final _Future<Null> _nullFuture = _Future<Null>.zoneValue(null);
final _Future<bool> _falseFuture = _Future<bool>.zoneValue(false);

abstract interface class Future<T> {
  factory Future(FutureOr<T> computation()) {
    _Future<T> result = _Future<T>();
    Timer.run(() {
      FutureOr<T> computationResult;
      try {
        computationResult = computation();
      } catch (e, s) {
        _completeWithErrorCallback(result, e, s);
        return;
      }
      result._complete(computationResult);
    });
    return result;
  }
  factory Future.microtask(FutureOr<T> computation()) {
    _Future<T> result = _Future<T>();
    scheduleMicrotask(() {
      FutureOr<T> computationResult;
      try {
        computationResult = computation();
      } catch (e, s) {
        _completeWithErrorCallback(result, e, s);
        return;
      }
      result._complete(computationResult);
    });
    return result;
  }
  factory Future.sync(FutureOr<T> computation()) {
    FutureOr<T> result;
    try {
      result = computation();
    } catch (error, stackTrace) {
      return _Future<T>().._asyncCompleteErrorObject(_interceptCaughtError(error, stackTrace));
    }
    return result is Future<T> ? result : _Future<T>.value(result);
  }
  factory Future.syncValue(T value) => _Future<T>().._setValue(value);
  factory Future.value([FutureOr<T>? value]) {
    return _Future<T>.immediate(value == null ? value as T : value);
  }
  factory Future.error(Object error, [StackTrace? stackTrace]) =>
      _Future<T>.immediateError(_interceptUserError(error, stackTrace));
  factory Future.delayed(Duration duration, [FutureOr<T> Function()? computation]) {
    if (computation == null && null is! T) {
      throw ArgumentError.value(null, "computation", "The type parameter is not nullable");
    }
    _Future<T> result = _Future<T>();
    Timer(duration, () {
      if (computation == null) {
        result._complete(null as T);
      } else {
        FutureOr<T> computationResult;
        try {
          computationResult = computation();
        } catch (e, s) {
          _completeWithErrorCallback(result, e, s);
          return;
        }
        result._complete(computationResult);
      }
    });
    return result;
  }
  static Future<void> pause([Duration duration = Duration.zero]) {
    var result = _Future<void>();
    Timer(duration, () {
      result._completeWithValue(null);
    });
    return result;
  }
  static Future<List<T>> wait<T>(Iterable<Future<T>> futures, {bool eagerError = false, void cleanUp(T successValue)?}) {
    final _Future<List<T>> _future = _Future<List<T>>();
    List<T?>? values;
    int remaining = 0;
    Object? error;
    StackTrace? stackTrace;
    void handleError(Object theError, StackTrace theStackTrace) {
      var remainingResults = --remaining;
      List<T?>? valueList = values;
      if (valueList != null) {
        values = null;
        error = theError;
        stackTrace = theStackTrace;
        if (cleanUp != null) {
          for (var value in valueList) {
            if (value != null) {
              T cleanUpValue = value;
              Future.sync(() {
                cleanUp(cleanUpValue);
              });
            }
          }
        }
        if (remainingResults == 0 || eagerError) {
          _future._completeError(theError, theStackTrace);
        }
      } else {
        if (remainingResults == 0 && !eagerError) {
          _future._completeError(error!, stackTrace!);
        }
      }
    }
    try {
      for (var future in futures) {
        int pos = remaining;
        future.then((T value) {
          var remainingResults = --remaining;
          List<T?>? valueList = values;
          if (valueList != null) {
            valueList[pos] = value;
            if (remainingResults == 0) {
              _future._completeWithValue([for (var value in valueList) value as T]);
            }
          } else {
            if (cleanUp != null && value != null) {
              Future.sync(() {
                cleanUp(value);
              });
            }
            if (remainingResults == 0 && !eagerError) {
              _future._completeError(error!, stackTrace!);
            }
          }
        }, onError: handleError);
        remaining++;
      }
      if (remaining == 0) {
        return _future.._completeWithValue(<T>[]);
      }
      values = List<T?>.filled(remaining, null);
    } catch (e, s) {
      if (remaining == 0 || eagerError) {
        return _future.._asyncCompleteErrorObject(_interceptCaughtError(e, s));
      } else {
        error = e;
        stackTrace = s;
      }
    }
    return _future;
  }
  static Future<T> any<T>(Iterable<Future<T>> futures) {
    var completer = Completer<T>.sync();
    void onValue(T value) {
      if (!completer.isCompleted) completer.complete(value);
    }
    void onError(Object error, StackTrace stack) {
      if (!completer.isCompleted) completer.completeError(error, stack);
    }
    for (var future in futures) {
      future.then(onValue, onError: onError);
    }
    return completer.future;
  }
  static Future<void> forEach<T>(Iterable<T> elements, FutureOr action(T element)) {
    var iterator = elements.iterator;
    return doWhile(() {
      if (!iterator.moveNext()) return false;
      var result = action(iterator.current);
      if (result is Future) return result.then(_kTrue);
      return true;
    });
  }
  static bool _kTrue(Object? _) => true;
  static Future<void> doWhile(FutureOr<bool> action()) {
    _Future<void> doneSignal = _Future<void>();
    late void Function(bool) nextIteration;
    nextIteration = (bool keepGoing) {
      while (keepGoing) {
        FutureOr<bool> result;
        try {
          result = action();
        } catch (error, stackTrace) {
          doneSignal._asyncCompleteErrorObject(_interceptCaughtError(error, stackTrace));
          return;
        }
        if (result is Future<bool>) {
          result.then(nextIteration, onError: doneSignal._completeError);
          return;
        }
        keepGoing = result;
      }
      doneSignal._complete(null);
    };
    nextIteration(true);
    return doneSignal;
  }
  Future<R> then<R>(FutureOr<R> onValue(T value), {Function? onError});
  Future<T> catchError(Function onError, {bool test(Object error)?});
  Future<T> whenComplete(FutureOr<void> action());
  Stream<T> asStream();
  Future<T> timeout(Duration timeLimit, {FutureOr<T> onTimeout()?});
}

void unawaited(Future<void>? future) {}

extension FutureExtensions<T> on Future<T> {
  Future<T> onError<E extends Object>(FutureOr<T> handleError(E error, StackTrace stackTrace), {bool test(E error)?}) {
    FutureOr<T> onError(Object error, StackTrace stackTrace) {
      if (error is! E || test != null && !test(error)) {
        throw error;
      }
      return handleError(error, stackTrace);
    }
    var self = this;
    if (self is _Future<T>) {
      return self._safeOnError<T>(onError);
    }
    return this.then<T>((T value) => value, onError: onError);
  }
  void ignore() {
    var self = this;
    if (self is _Future<T>) {
      self._ignore();
    } else {
      self.then<void>(_ignore, onError: _ignore);
    }
  }
  static void _ignore(Object? _, [Object? __]) {}
}

class TimeoutException implements Exception {
  final String? message;
  final Duration? duration;
  TimeoutException(this.message, [this.duration]);
  String toString() {
    String result = "TimeoutException";
    if (duration != null) result = "TimeoutException after " + duration.toString();
    if (message != null) result = result + ": " + message!;
    return result;
  }
}

abstract interface class Completer<T> {
  factory Completer() => _AsyncCompleter<T>();
  factory Completer.sync() => _SyncCompleter<T>();
  Future<T> get future;
  void complete([FutureOr<T>? value]);
  void completeError(Object error, [StackTrace? stackTrace]);
  bool get isCompleted;
}

void _completeWithErrorCallback(_Future result, Object error, StackTrace stackTrace) {
  result._completeErrorObject(_interceptCaughtError(error, stackTrace));
}

/** The replacement a zone's error callback gives an error, which the root zone never does. */
AsyncError? _interceptError(Object error, StackTrace? stackTrace) => null;

AsyncError _interceptCaughtError(Object error, StackTrace? stackTrace) => AsyncError(error, stackTrace);

AsyncError _interceptUserError(Object error, StackTrace? stackTrace) {
  if (stackTrace == null) {
    if (error is Error) {
      stackTrace = error.stackTrace ?? StackTrace.empty;
    } else {
      stackTrace = StackTrace.empty;
    }
  }
  return AsyncError._(error, stackTrace);
}

final class AsyncError implements Error {
  final Object error;
  final StackTrace stackTrace;
  AsyncError(Object error, StackTrace? stackTrace)
      : error = error,
        stackTrace = stackTrace ?? defaultStackTrace(error);
  AsyncError._(this.error, this.stackTrace);
  static StackTrace defaultStackTrace(Object error) {
    if (error is Error) {
      var stackTrace = error.stackTrace;
      if (stackTrace != null) return stackTrace;
    }
    return StackTrace.empty;
  }
  String toString() => error.toString();
}

abstract class _Completer<T> implements Completer<T> {
  final _Future<T> future = _Future<T>();
  void complete([FutureOr<T>? value]);
  void completeError(Object error, [StackTrace? stackTrace]) {
    if (!future._mayComplete) throw StateError("Future already completed");
    _completeErrorObject(_interceptUserError(error, stackTrace));
  }
  void _completeErrorObject(AsyncError error);
  bool get isCompleted => !future._mayComplete;
}

class _AsyncCompleter<T> extends _Completer<T> {
  void complete([FutureOr<T>? value]) {
    if (!future._mayComplete) throw StateError("Future already completed");
    future._asyncComplete(value == null ? value as dynamic : value);
  }
  void _completeErrorObject(AsyncError error) {
    future._asyncCompleteErrorObject(error);
  }
}

class _SyncCompleter<T> extends _Completer<T> {
  void complete([FutureOr<T>? value]) {
    if (!future._mayComplete) throw StateError("Future already completed");
    future._complete(value == null ? value as dynamic : value);
  }
  void _completeErrorObject(AsyncError error) {
    future._completeErrorObject(error);
  }
}

class _FutureListener<S, T> {
  static const int maskValue = 1;
  static const int maskError = 2;
  static const int maskTestError = 4;
  static const int maskWhenComplete = 8;
  static const int maskAwait = 16;
  static const int stateChain = 0;
  static const int stateThen = maskValue;
  static const int stateThenOnerror = maskValue | maskError;
  static const int stateThenAwait = stateThenOnerror | maskAwait;
  static const int stateCatchError = maskError;
  static const int stateCatchErrorTest = maskError | maskTestError;
  static const int stateWhenComplete = maskWhenComplete;
  static const int maskType = maskValue | maskError | maskTestError | maskWhenComplete;
  _FutureListener? _nextListener;
  final _Future<T> result;
  final int state;
  final Function? callback;
  final Function? errorCallback;
  _FutureListener.then(this.result, FutureOr<T> Function(S) onValue, Function? errorCallback)
      : callback = onValue,
        errorCallback = errorCallback,
        state = (errorCallback == null) ? stateThen : stateThenOnerror;
  _FutureListener.thenAwait(this.result, FutureOr<T> Function(S) onValue, Function errorCallback)
      : callback = onValue,
        errorCallback = errorCallback,
        state = stateThenAwait;
  _FutureListener.catchError(this.result, this.errorCallback, this.callback)
      : state = (callback == null) ? stateCatchError : stateCatchErrorTest;
  _FutureListener.whenComplete(this.result, this.callback)
      : errorCallback = null,
        state = stateWhenComplete;
  bool get handlesValue => (state & maskValue != 0);
  bool get handlesError => (state & maskError != 0);
  bool get hasErrorTest => (state & maskType == stateCatchErrorTest);
  bool get handlesComplete => (state & maskType == stateWhenComplete);
  FutureOr<T> Function(S) get _onValue => callback as FutureOr<T> Function(S);
  Function? get _onError => errorCallback;
  bool Function(Object) get _errorTest => callback as bool Function(Object);
  dynamic Function() get _whenCompleteAction => callback as dynamic Function();
  bool get hasErrorCallback => _onError != null;
  FutureOr<T> handleValue(S sourceResult) => _onValue(sourceResult);
  bool matchesErrorTest(AsyncError asyncError) {
    if (!hasErrorTest) return true;
    return _errorTest(asyncError.error);
  }
  FutureOr<T> handleError(AsyncError asyncError) {
    var errorCallback = this.errorCallback;
    dynamic result;
    if (errorCallback is dynamic Function(Object, StackTrace)) {
      result = errorCallback(asyncError.error, asyncError.stackTrace);
    } else {
      result = (errorCallback as dynamic)(asyncError.error);
    }
    try {
      return result;
    } on TypeError {
      if (handlesValue) {
        throw ArgumentError("The error handler of Future.then must return a value of the returned future's type", "onError");
      }
      throw ArgumentError("The error handler of Future.catchError must return a value of the future's type", "onError");
    }
  }
  dynamic handleWhenComplete() => _whenCompleteAction();
  bool shouldChain(Future<dynamic> value) => value is Future<T> || value is! T;
}

class _Future<T> implements Future<T> {
  static const int _stateIncomplete = 0;
  static const int _stateIgnoreError = 1;
  static const int _statePendingComplete = 2;
  static const int _stateChained = 4;
  static const int _stateValue = 8;
  static const int _stateError = 16;
  static const int _completionStateMask = 30;
  int _state = _stateIncomplete;
  var _resultOrListeners;
  _Future();
  _Future.immediate(FutureOr<T> result) {
    _asyncComplete(result);
  }
  _Future.zoneValue(T value) {
    _setValue(value);
  }
  _Future.immediateError(AsyncError error) {
    _asyncCompleteErrorObject(error);
  }
  _Future.value(T value) : this.zoneValue(value);
  bool get _mayComplete => (_state & _completionStateMask) == _stateIncomplete;
  bool get _isPendingComplete => (_state & _statePendingComplete) != 0;
  bool get _mayAddListener => _state <= (_statePendingComplete | _stateIgnoreError);
  bool get _isChained => (_state & _stateChained) != 0;
  bool get _isComplete => (_state & (_stateValue | _stateError)) != 0;
  bool get _hasError => (_state & _stateError) != 0;
  bool get _ignoreError => (_state & _stateIgnoreError) != 0;
  void _setChained(_Future source) {
    _state = _stateChained | (_state & _stateIgnoreError);
    _resultOrListeners = source;
  }
  Future<R> then<R>(FutureOr<R> f(T value), {Function? onError}) {
    if (onError != null && onError is! Function(Object, StackTrace) && onError is! Function(Object)) {
      throw ArgumentError.value(onError, "onError",
          "Error handler must accept one Object or one Object and a StackTrace as arguments, and return a value of the returned future's type");
    }
    _Future<R> result = _Future<R>();
    _addListener(_FutureListener<T, R>.then(result, f, onError));
    return result;
  }
  Future<E> _thenAwait<E>(FutureOr<E> f(T value), Function onError) {
    _Future<E> result = _Future<E>();
    _addListener(_FutureListener<T, E>.thenAwait(result, f, onError));
    return result;
  }
  void _ignore() {
    _state |= _stateIgnoreError;
    if (_isChained) {
      _Future<Object?> source = this;
      do {
        source = source._chainSource;
      } while (source._isChained);
      source._state |= _stateIgnoreError;
    }
  }
  Future<T> catchError(Function onError, {bool test(Object error)?}) {
    _Future<T> result = _Future<T>();
    if (onError is! Function(Object, StackTrace) && onError is! Function(Object)) {
      throw ArgumentError.value(onError, "onError",
          "Error handler must accept one Object or one Object and a StackTrace as arguments, and return a value of the returned future's type");
    }
    _addListener(_FutureListener<T, T>.catchError(result, onError, test));
    return result;
  }
  Future<R> _safeOnError<R>(FutureOr<R> Function(Object, StackTrace) onError) {
    _Future<R> result = _Future<R>();
    _addListener(_FutureListener<T, R>.catchError(result, onError, null));
    return result;
  }
  Future<T> whenComplete(dynamic action()) {
    _Future<T> result = _Future<T>();
    _addListener(_FutureListener<T, T>.whenComplete(result, action));
    return result;
  }
  Stream<T> asStream() => Stream<T>.fromFuture(this);
  void _setPendingComplete() {
    _state ^= _stateIncomplete ^ _statePendingComplete;
  }
  void _clearPendingComplete() {
    _state ^= _statePendingComplete ^ _stateIncomplete;
  }
  AsyncError get _error => _resultOrListeners;
  _Future get _chainSource => _resultOrListeners;
  void _setValue(T value) {
    _state = _stateValue;
    _resultOrListeners = value;
  }
  void _setErrorObject(AsyncError error) {
    _state = _stateError | (_state & _stateIgnoreError);
    _resultOrListeners = error;
  }
  void _cloneResult(_Future source) {
    _state = (source._state & _completionStateMask) | (_state & _stateIgnoreError);
    _resultOrListeners = source._resultOrListeners;
  }
  void _addListener(_FutureListener listener) {
    if (_mayAddListener) {
      listener._nextListener = _resultOrListeners;
      _resultOrListeners = listener;
    } else {
      if (_isChained) {
        _Future source = _chainSource;
        if (!source._isComplete) {
          source._addListener(listener);
          return;
        }
        _cloneResult(source);
      }
      scheduleMicrotask(() {
        _propagateToListeners(this, listener);
      });
    }
  }
  void _prependListeners(_FutureListener? listeners) {
    if (listeners == null) return;
    if (_mayAddListener) {
      _FutureListener? existingListeners = _resultOrListeners;
      _resultOrListeners = listeners;
      if (existingListeners != null) {
        _FutureListener cursor = listeners;
        _FutureListener? next = cursor._nextListener;
        while (next != null) {
          cursor = next;
          next = cursor._nextListener;
        }
        cursor._nextListener = existingListeners;
      }
    } else {
      if (_isChained) {
        _Future source = _chainSource;
        if (!source._isComplete) {
          source._prependListeners(listeners);
          return;
        }
        _cloneResult(source);
      }
      listeners = _reverseListeners(listeners);
      scheduleMicrotask(() {
        _propagateToListeners(this, listeners);
      });
    }
  }
  _FutureListener? _removeListeners() {
    _FutureListener? current = _resultOrListeners;
    _resultOrListeners = null;
    return _reverseListeners(current);
  }
  _FutureListener? _reverseListeners(_FutureListener? listeners) {
    _FutureListener? prev = null;
    _FutureListener? current = listeners;
    while (current != null) {
      _FutureListener? next = current._nextListener;
      current._nextListener = prev;
      prev = current;
      current = next;
    }
    return prev;
  }
  void _chainForeignFuture(Future source) {
    _setPendingComplete();
    try {
      source.then((value) {
        _clearPendingComplete();
        try {
          _completeWithValue(value as T);
        } catch (error, stackTrace) {
          _completeError(error, stackTrace);
        }
      }, onError: (Object error, StackTrace stackTrace) {
        _completeError(error, stackTrace);
      });
    } catch (e, s) {
      scheduleMicrotask(() {
        _completeError(e, s);
      });
    }
  }
  static void _chainCoreFuture(_Future source, _Future target, bool sync) {
    while (source._isChained) {
      source = source._chainSource;
    }
    if (identical(source, target)) {
      target._asyncCompleteError(ArgumentError.value(source, null, "Cannot complete a future with itself"), StackTrace.empty);
      return;
    }
    var ignoreError = target._state & _stateIgnoreError;
    source._state |= ignoreError;
    if (!source._isComplete) {
      _FutureListener? listeners = target._resultOrListeners;
      target._setChained(source);
      source._prependListeners(listeners);
      return;
    }
    if (sync || (target._resultOrListeners == null && (!source._hasError || ignoreError != 0))) {
      _FutureListener? listeners = target._removeListeners();
      target._cloneResult(source);
      _propagateToListeners(target, listeners);
      return;
    }
    target._setPendingComplete();
    scheduleMicrotask(() {
      _chainCoreFuture(source, target, true);
    });
  }
  void _complete(FutureOr<T> value) {
    if (value is Future<T>) {
      if (value is _Future<T>) {
        _chainCoreFuture(value, this, true);
      } else {
        _chainForeignFuture(value);
      }
    } else {
      _FutureListener? listeners = _removeListeners();
      _setValue(value as T);
      _propagateToListeners(this, listeners);
    }
  }
  void _completeWithValue(T value) {
    _FutureListener? listeners = _removeListeners();
    _setValue(value);
    _propagateToListeners(this, listeners);
  }
  void _completeWithResultOf(_Future<Object?> source) {
    _FutureListener? listeners = _removeListeners();
    _cloneResult(source);
    _propagateToListeners(this, listeners);
  }
  void _completeErrorObject(AsyncError error) {
    _FutureListener? listeners = _removeListeners();
    _setErrorObject(error);
    _propagateToListeners(this, listeners);
  }
  void _completeError(Object error, StackTrace stackTrace) {
    _completeErrorObject(AsyncError(error, stackTrace));
  }
  void _asyncComplete(FutureOr<T> value) {
    if (value is Future<T>) {
      _chainFuture(value);
      return;
    }
    _asyncCompleteWithValue(value as T);
  }
  void _asyncCompleteUnchecked(dynamic value) {
    if (value is Future<T>) {
      _chainFuture(value);
      return;
    }
    _asyncCompleteWithValue(value as T);
  }
  void _asyncCompleteWithValue(T value) {
    _setPendingComplete();
    scheduleMicrotask(() {
      _completeWithValue(value);
    });
  }
  void _chainFuture(Future<T> value) {
    if (value is _Future<T>) {
      _chainCoreFuture(value, this, false);
      return;
    }
    _chainForeignFuture(value);
  }
  void _asyncCompleteError(Object error, StackTrace stackTrace) {
    _asyncCompleteErrorObject(AsyncError(error, stackTrace));
  }
  void _asyncCompleteErrorObject(AsyncError error) {
    _setPendingComplete();
    scheduleMicrotask(() {
      _completeErrorObject(error);
    });
  }
  static void _propagateToListeners(_Future source, _FutureListener? listeners) {
    while (true) {
      bool hasError = source._hasError;
      if (listeners == null) {
        if (hasError && !source._ignoreError) {
          AsyncError asyncError = source._error;
          _rootHandleError(asyncError.error, asyncError.stackTrace);
        }
        return;
      }
      _FutureListener listener = listeners;
      _FutureListener? nextListener = listener._nextListener;
      while (nextListener != null) {
        listener._nextListener = null;
        _propagateToListeners(source, listener);
        listener = nextListener;
        nextListener = listener._nextListener;
      }
      final dynamic sourceResult = source._resultOrListeners;
      bool listenerHasError = hasError;
      var listenerValueOrError = sourceResult;
      if (hasError || listener.handlesValue || listener.handlesComplete) {
        void handleWhenCompleteCallback() {
          var completeResult;
          try {
            completeResult = listener.handleWhenComplete();
          } catch (e, s) {
            if (hasError && identical(source._error.error, e)) {
              listenerValueOrError = source._error;
            } else {
              listenerValueOrError = AsyncError(e, s);
            }
            listenerHasError = true;
            return;
          }
          if (completeResult is _Future && completeResult._isComplete) {
            if (completeResult._hasError) {
              listenerValueOrError = completeResult._error;
              listenerHasError = true;
            }
            return;
          }
          if (completeResult is Future) {
            var originalSource = source;
            var joinedResult = source._newFutureWithSameType();
            completeResult.then<void>((_) {
              joinedResult._completeWithResultOf(originalSource);
            }, onError: (Object e, StackTrace s) {
              joinedResult._completeErrorObject(AsyncError(e, s));
            });
            listenerValueOrError = joinedResult;
            listenerHasError = false;
          }
        }
        void handleValueCallback() {
          try {
            listenerValueOrError = listener.handleValue(sourceResult);
          } catch (e, s) {
            listenerValueOrError = AsyncError(e, s);
            listenerHasError = true;
          }
        }
        void handleError() {
          try {
            AsyncError asyncError = source._error;
            if (listener.matchesErrorTest(asyncError) && listener.hasErrorCallback) {
              listenerValueOrError = listener.handleError(asyncError);
              listenerHasError = false;
            }
          } catch (e, s) {
            if (identical(source._error.error, e)) {
              listenerValueOrError = source._error;
            } else {
              listenerValueOrError = AsyncError(e, s);
            }
            listenerHasError = true;
          }
        }
        if (listener.handlesComplete) {
          handleWhenCompleteCallback();
        } else if (!hasError) {
          if (listener.handlesValue) {
            handleValueCallback();
          }
        } else {
          if (listener.handlesError) {
            handleError();
          }
        }
        if (listenerValueOrError is Future && listener.shouldChain(listenerValueOrError)) {
          Future chainSource = listenerValueOrError;
          _Future result = listener.result;
          if (chainSource is _Future) {
            if (chainSource._isComplete) {
              listeners = result._removeListeners();
              result._cloneResult(chainSource);
              source = chainSource;
              continue;
            } else {
              _chainCoreFuture(chainSource, result, true);
            }
          } else {
            result._chainForeignFuture(chainSource);
          }
          return;
        }
      }
      _Future result = listener.result;
      listeners = result._removeListeners();
      if (!listenerHasError) {
        result._setValue(listenerValueOrError);
      } else {
        AsyncError asyncError = listenerValueOrError;
        result._setErrorObject(asyncError);
      }
      source = result;
    }
  }
  _Future<T> _newFutureWithSameType() => _Future<T>();
  Future<T> timeout(Duration timeLimit, {FutureOr<T> onTimeout()?}) {
    if (_isComplete) return _Future.immediate(this);
    _Future<T> _future = _Future<T>();
    Timer timer;
    if (onTimeout == null) {
      timer = Timer(timeLimit, () {
        _future._completeErrorObject(AsyncError(TimeoutException("Future not completed", timeLimit), StackTrace.empty));
      });
    } else {
      timer = Timer(timeLimit, () {
        try {
          _future._complete(onTimeout());
        } catch (e, s) {
          _future._completeErrorObject(AsyncError(e, s));
        }
      });
    }
    this.then((T v) {
      if (timer.isActive) {
        timer.cancel();
        _future._completeWithValue(v);
      }
    }, onError: (Object e, StackTrace s) {
      if (timer.isActive) {
        timer.cancel();
        _future._completeErrorObject(AsyncError(e, s));
      }
    });
    return _future;
  }
}

extension FutureIterable<T> on Iterable<Future<T>> {
  Future<List<T>> get wait {
    var results = [for (var f in this) _FutureResult<T>(f)];
    if (results.isEmpty) return Future<List<T>>.value(<T>[]);
    final c = Completer<List<T>>.sync();
    _FutureResult._waitAll(results, (errors) {
      if (errors == 0) {
        c.complete([for (var r in results) r.value]);
      } else {
        var errorList = [for (var r in results) r.errorOrNull];
        c.completeError(ParallelWaitError<List<T?>, List<AsyncError?>>(
          [for (var r in results) r.valueOrNull],
          errorList,
          errorCount: errors,
          defaultError: errorList.firstWhere(_notNull),
        ));
      }
    });
    return c.future;
  }
}

bool _notNull(Object? object) => object != null;
` +
  futureRecordExtensions() +
  String.raw`
class ParallelWaitError<V, E> extends Error {
  final V values;
  final E errors;
  final int? _errorCount;
  final AsyncError? _defaultError;
  ParallelWaitError(this.values, this.errors, {int? errorCount, AsyncError? defaultError})
      : _defaultError = defaultError,
        _errorCount = errorCount;
  String toString() {
    if (_defaultError == null) {
      if (_errorCount == null || _errorCount! <= 1) {
        return "ParallelWaitError";
      }
      return "ParallelWaitError(" + _errorCount.toString() + " errors)";
    }
    return "ParallelWaitError" +
        ((_errorCount != null && _errorCount! > 1) ? "(" + _errorCount.toString() + " errors)" : "") +
        ": " + _defaultError!.error.toString();
  }
  StackTrace? get stackTrace => _defaultError?.stackTrace ?? super.stackTrace;
}

class _FutureResult<T> {
  final Future<T> source;
  T? _value;
  AsyncError? errorOrNull;
  _FutureResult(this.source);
  T get value => _value ?? _value as T;
  T? get valueOrNull => _value;
  static void _waitAll(List<_FutureResult> results, void Function(int) whenReady) {
    var ready = 0;
    var errors = 0;
    void onReady(int error) {
      errors += error;
      if (++ready == results.length) {
        whenReady(errors);
      }
    }
    for (var result in results) {
      result.source.then((value) {
        result._value = value;
        onReady(0);
      }, onError: (Object error, StackTrace stack) {
        result.errorOrNull = AsyncError(error, stack);
        onReady(1);
      });
    }
  }
}

typedef void _AsyncCallback();

class _AsyncCallbackEntry {
  final _AsyncCallback callback;
  _AsyncCallbackEntry? next;
  _AsyncCallbackEntry(this.callback);
}

_AsyncCallbackEntry? _nextCallback;
_AsyncCallbackEntry? _lastCallback;
_AsyncCallbackEntry? _lastPriorityCallback;
bool _isInCallbackLoop = false;

void _microtaskLoop() {
  for (var entry = _nextCallback; entry != null; entry = _nextCallback) {
    _lastPriorityCallback = null;
    var next = entry.next;
    _nextCallback = next;
    if (next == null) _lastCallback = null;
    (entry.callback)();
  }
}

void _startMicrotaskLoop() {
  _isInCallbackLoop = true;
  try {
    _microtaskLoop();
  } finally {
    _lastPriorityCallback = null;
    _isInCallbackLoop = false;
    if (_nextCallback != null) {
      _scheduleImmediate(_startMicrotaskLoop);
    }
  }
}

void _scheduleAsyncCallback(_AsyncCallback callback) {
  _AsyncCallbackEntry newEntry = _AsyncCallbackEntry(callback);
  _AsyncCallbackEntry? lastCallback = _lastCallback;
  if (lastCallback == null) {
    _nextCallback = _lastCallback = newEntry;
    if (!_isInCallbackLoop) {
      _scheduleImmediate(_startMicrotaskLoop);
    }
  } else {
    lastCallback.next = newEntry;
    _lastCallback = newEntry;
  }
}

void _schedulePriorityAsyncCallback(_AsyncCallback callback) {
  if (_nextCallback == null) {
    _scheduleAsyncCallback(callback);
    _lastPriorityCallback = _lastCallback;
    return;
  }
  _AsyncCallbackEntry entry = _AsyncCallbackEntry(callback);
  _AsyncCallbackEntry? lastPriorityCallback = _lastPriorityCallback;
  if (lastPriorityCallback == null) {
    entry.next = _nextCallback;
    _nextCallback = _lastPriorityCallback = entry;
  } else {
    var next = lastPriorityCallback.next;
    entry.next = next;
    lastPriorityCallback.next = entry;
    _lastPriorityCallback = entry;
    if (next == null) {
      _lastCallback = entry;
    }
  }
}

void scheduleMicrotask(void Function() callback) {
  _scheduleAsyncCallback(callback);
}

external void _scheduleImmediate(void Function() callback);

void _rootHandleError(Object error, StackTrace stackTrace) {
  _schedulePriorityAsyncCallback(() {
    Error.throwWithStackTrace(error, stackTrace);
  });
}

abstract interface class Timer {
  factory Timer(Duration duration, void Function() callback) =>
      _Timer(duration.inMilliseconds, (Timer timer) => callback(), false);
  factory Timer.periodic(Duration duration, void callback(Timer timer)) =>
      _Timer(duration.inMilliseconds, callback, true);
  static void run(void Function() callback) {
    Timer(Duration.zero, callback);
  }
  void cancel();
  int get tick;
  bool get isActive;
}

final class _Timer implements Timer {
  void Function(Timer)? _callback;
  final int _milliSeconds;
  final bool _repeating;
  int _tick = 0;
  _Timer(int milliSeconds, this._callback, this._repeating) : _milliSeconds = milliSeconds < 0 ? 0 : milliSeconds {
    _schedule(_milliSeconds == 0 ? 0 : _milliSeconds + 1);
  }
  bool get isActive => _callback != null;
  int get tick => _tick;
  void cancel() {
    _callback = null;
    _unschedule();
  }
  void _run() {
    var callback = _callback;
    if (callback == null) return;
    if (!_repeating) _callback = null;
    _tick += 1;
    callback(this);
    if (_repeating && _callback != null) _reschedule(_milliSeconds);
  }
  external void _schedule(int delay);
  external void _reschedule(int period);
  external void _unschedule();
}

abstract final class _DeferredLoading {
  static Future<void> load(String prefix) async {
    await Future<void>(() {
      _markLoaded(prefix);
    });
  }
  external static void _markLoaded(String prefix);
}

class _DeferredNotLoadedError extends Error {
  final String _prefix;
  _DeferredNotLoadedError(this._prefix);
  String toString() => "Deferred library " + _prefix + " was not loaded.";
}

class _SuspendState {
  void Function(dynamic)? _thenCallback;
  void Function(Object, StackTrace)? _errorCallback;
  final Object _functionData;
  _SuspendState(this._functionData);
  void _createAsyncCallbacks() {
    final suspendState = this;
    _thenCallback = (value) {
      suspendState._resume(value, null, null);
    };
    _errorCallback = (Object exception, StackTrace stackTrace) {
      suspendState._resume(null, exception, stackTrace);
    };
  }
  void _awaitCompletedFuture(_Future future) {
    if (future._hasError) {
      scheduleMicrotask(() {
        final AsyncError asyncError = future._resultOrListeners;
        _errorCallback!(asyncError.error, asyncError.stackTrace);
      });
    } else {
      scheduleMicrotask(() {
        _thenCallback!(future._resultOrListeners);
      });
    }
  }
  void _awaitNotFuture(Object? object) {
    scheduleMicrotask(() {
      _thenCallback!(object);
    });
  }
  void _awaitUserDefinedFuture(Future future) {
    future.then((value) => _thenCallback!(value), onError: _errorCallback);
  }
  void _await(Object? object) {
    if (_thenCallback == null) {
      _createAsyncCallbacks();
    }
    if (object is _Future) {
      if (object._isComplete) {
        _awaitCompletedFuture(object);
      } else {
        object._thenAwait<dynamic>(_thenCallback!, _errorCallback!);
      }
    } else if (object is! Future) {
      _awaitNotFuture(object);
    } else {
      _awaitUserDefinedFuture(object);
    }
  }
  void _returnAsync(Object? returnValue) {
    final future = _functionData as _Future;
    if (returnValue is Future) {
      future._asyncCompleteUnchecked(returnValue);
    } else {
      future._completeWithValue(returnValue);
    }
  }
  void _handleException(bool isSync, Object exception, StackTrace stackTrace) {
    final functionData = _functionData;
    if (functionData is _Future) {
      if (!isSync) {
        functionData._asyncCompleteError(exception, stackTrace);
      } else {
        functionData._completeError(exception, stackTrace);
      }
    } else if (functionData is _AsyncStarStreamController) {
      functionData.addError(exception, stackTrace);
      functionData.close();
    }
  }
  Stream _startAsyncStar() {
    final controller = _functionData as _AsyncStarStreamController;
    final suspendState = this;
    controller.asyncStarBody = (value) {
      suspendState._resume(value, null, null);
    };
    return controller.stream;
  }
  bool _yieldAsyncStar(Object? value) => (_functionData as _AsyncStarStreamController).add(value);
  bool _yieldEachAsyncStar(Object? stream) => (_functionData as _AsyncStarStreamController).addStream(stream as Stream);
  void _returnAsyncStar() {
    (_functionData as _AsyncStarStreamController).close();
  }
  external void _resume(Object? value, Object? exception, StackTrace? stackTrace);
}
` +
  STREAM_SOURCE;
