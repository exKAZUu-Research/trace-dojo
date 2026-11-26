/** dart:async's streams: the SDK's, transcribed with every zone being the root zone. The source must not contain `${`. */
export const STREAM_SOURCE = String.raw`
abstract mixin class Stream<T> {
  const Stream();
  const factory Stream.empty({ bool broadcast}) = _EmptyStream<T>;
  factory Stream.value(T value) =>
      (_AsyncStreamController<T>(null, null, null, null)
            .._add(value)
            .._closeUnchecked())
          .stream;
  factory Stream.error(Object error, [StackTrace? stackTrace]) {
    AsyncError(:error, :stackTrace) = _interceptUserError(error, stackTrace);
    return (_AsyncStreamController<T>(null, null, null, null)
          .._addError(error, stackTrace)
          .._closeUnchecked())
        .stream;
  }
  factory Stream.fromFuture(Future<T> future) {
    _StreamController<T> controller = _SyncStreamController<T>(
      null,
      null,
      null,
      null,
    );
    future.then(
      (value) {
        controller._add(value);
        controller._closeUnchecked();
      },
      onError: (error, stackTrace) {
        controller._addError(error, stackTrace);
        controller._closeUnchecked();
      },
    );
    return controller.stream;
  }
  factory Stream.fromFutures(Iterable<Future<T>> futures) {
    _StreamController<T> controller = _SyncStreamController<T>(
      null,
      null,
      null,
      null,
    );
    int count = 0;
    void onValue(T value) {
      if (!controller.isClosed) {
        controller._add(value);
        if (--count == 0) controller._closeUnchecked();
      }
    }
    void onError(Object error, StackTrace stack) {
      if (!controller.isClosed) {
        controller._addError(error, stack);
        if (--count == 0) controller._closeUnchecked();
      }
    }
    for (var future in futures) {
      count++;
      future.then(onValue, onError: onError);
    }
    if (count == 0) scheduleMicrotask(controller.close);
    return controller.stream;
  }
  factory Stream.fromIterable(Iterable<T> elements) =>
      Stream<T>.multi((controller) {
        Iterator<T> iterator;
        try {
          iterator = elements.iterator;
        } catch (e, s) {
          var error = _interceptCaughtError(e, s);
          controller.addError(error.error, error.stackTrace);
          controller.close();
          return;
        }
        var isScheduled = true;
        void next() {
          if (!controller.hasListener || controller.isPaused) {
            isScheduled = false;
            return;
          }
          bool hasNext;
          try {
            hasNext = iterator.moveNext();
          } catch (e, s) {
            var error = _interceptCaughtError(e, s);
            controller.addErrorSync(error.error, error.stackTrace);
            controller.closeSync();
            return;
          }
          if (hasNext) {
            try {
              controller.addSync(iterator.current);
            } catch (e, s) {
              var error = _interceptCaughtError(e, s);
              controller.addErrorSync(error.error, error.stackTrace);
            }
            if (controller.hasListener && !controller.isPaused) {
              scheduleMicrotask(next);
            } else {
              isScheduled = false;
            }
          } else {
            controller.closeSync();
          }
        }
        controller.onResume = () {
          if (!isScheduled) {
            isScheduled = true;
            scheduleMicrotask(next);
          }
        };
        scheduleMicrotask(next);
      });
  factory Stream.multi(
    void Function(MultiStreamController<T>) onListen, {
    bool isBroadcast = false,
  }) {
    return _MultiStream<T>(onListen, isBroadcast);
  }
  factory Stream.periodic(
    Duration period, [
    T computation(int computationCount)?,
  ]) {
    if (computation == null && null is! T) {
      throw ArgumentError.value(
        null,
        "computation",
        "Must not be omitted when the event type is non-nullable",
      );
    }
    var controller = _SyncStreamController<T>(null, null, null, null);
    Stopwatch watch = Stopwatch();
    controller.onListen = () {
      int computationCount = 0;
      void sendEvent(_) {
        watch.reset();
        if (computation != null) {
          T event;
          try {
            event = computation(computationCount++);
          } catch (e, s) {
            var error = _interceptCaughtError(e, s);
            controller.addError(error.error, error.stackTrace);
            return;
          }
          controller.add(event);
        } else {
          controller.add(null as T);
        }
      }
      Timer timer = Timer.periodic(period, sendEvent);
      controller
        ..onCancel = () {
          timer.cancel();
          return _nullFuture;
        }
        ..onPause = () {
          watch.stop();
          timer.cancel();
        }
        ..onResume = () {
          Duration elapsed = watch.elapsed;
          watch.start();
          timer = Timer(period - elapsed, () {
            timer = Timer.periodic(period, sendEvent);
            sendEvent(null);
          });
        };
    };
    return controller.stream;
  }
  factory Stream.eventTransformed(
    Stream<dynamic> source,
    EventSink<dynamic> mapSink(EventSink<T> sink),
  ) {
    return _BoundSinkStream(source, mapSink);
  }
  static Stream<T> castFrom<S, T>(Stream<S> source) => CastStream<S, T>(source);
  bool get isBroadcast => false;
  Stream<T> asBroadcastStream({
    void onListen(StreamSubscription<T> subscription)?,
    void onCancel(StreamSubscription<T> subscription)?,
  }) {
    return _AsBroadcastStream<T>(this, onListen, onCancel);
  }
  StreamSubscription<T> listen(
    void onData(T event)?, {
    Function? onError,
    void onDone()?,
    bool? cancelOnError,
  });
  Stream<T> where(bool test(T event)) {
    return _WhereStream<T>(this, test);
  }
  Stream<S> map<S>(S convert(T event)) {
    return _MapStream<T, S>(this, convert);
  }
  Stream<E> asyncMap<E>(FutureOr<E> convert(T event)) {
    _StreamControllerBase<E> controller;
    if (isBroadcast) {
      controller = _SyncBroadcastStreamController<E>(null, null);
    } else {
      controller = _SyncStreamController<E>(null, null, null, null);
    }
    controller.onListen = () {
      StreamSubscription<T> subscription = this.listen(
        null,
        onError: controller._addError,
        onDone: controller.close,
      );
      FutureOr<Null> add(E value) {
        controller.add(value);
      }
      final addError = controller._addError;
      final resume = subscription.resume;
      subscription.onData((T event) {
        FutureOr<E> newValue;
        try {
          newValue = convert(event);
        } catch (e, s) {
          var error = _interceptCaughtError(e, s);
          controller.addError(error.error, error.stackTrace);
          return;
        }
        if (newValue is Future<E>) {
          subscription.pause();
          newValue.then(add, onError: addError).whenComplete(resume);
        } else {
          controller.add(newValue);
        }
      });
      controller.onCancel = subscription.cancel;
      if (!isBroadcast) {
        controller
          ..onPause = subscription.pause
          ..onResume = resume;
      }
    };
    return controller.stream;
  }
  Stream<E> asyncExpand<E>(Stream<E>? convert(T event)) {
    _StreamControllerBase<E> controller;
    if (isBroadcast) {
      controller = _SyncBroadcastStreamController<E>(null, null);
    } else {
      controller = _SyncStreamController<E>(null, null, null, null);
    }
    controller.onListen = () {
      StreamSubscription<T> subscription = this.listen(
        null,
        onError: controller._addError,
        onDone: controller.close,
      );
      subscription.onData((T event) {
        Stream<E>? newStream;
        try {
          newStream = convert(event);
        } catch (e, s) {
          var error = _interceptCaughtError(e, s);
          controller.addError(error.error, error.stackTrace);
          return;
        }
        if (newStream != null) {
          subscription.pause();
          controller.addStream(newStream).whenComplete(subscription.resume);
        }
      });
      controller.onCancel = subscription.cancel;
      if (!isBroadcast) {
        controller
          ..onPause = subscription.pause
          ..onResume = subscription.resume;
      }
    };
    return controller.stream;
  }
  Stream<T> handleError(Function onError, {bool test(error)?}) {
    final void Function(Object, StackTrace) callback;
    if (onError is void Function(Object, StackTrace)) {
      callback = onError;
    } else if (onError is void Function(Object)) {
      callback = (Object error, StackTrace _) {
        onError(error);
      };
    } else {
      throw ArgumentError.value(
        onError,
        "onError",
        "Error handler must accept one Object or one Object and a StackTrace"
            " as arguments.",
      );
    }
    return _HandleErrorStream<T>(this, callback, test);
  }
  Stream<S> expand<S>(Iterable<S> convert(T element)) {
    return _ExpandStream<T, S>(this, convert);
  }
  Future pipe(StreamConsumer<T> streamConsumer) {
    return streamConsumer.addStream(this).then((_) => streamConsumer.close());
  }
  Stream<S> transform<S>(StreamTransformer<T, S> streamTransformer) {
    return streamTransformer.bind(this);
  }
  Future<T> reduce(T combine(T previous, T element)) {
    _Future<T> result = _Future<T>();
    bool seenFirst = false;
    late T value;
    StreamSubscription<T> subscription = this.listen(
      null,
      onError: result._completeError,
      onDone: () {
        if (!seenFirst) {
          var stack = StackTrace.empty;
          var error = IterableElementError.noElement();
          _trySetStackTrace(error, stack);
          _completeWithErrorCallback(result, error, stack);
        } else {
          result._complete(value);
        }
      },
      cancelOnError: true,
    );
    subscription.onData((T element) {
      if (seenFirst) {
        _runUserCode(() => combine(value, element), (T newValue) {
          value = newValue;
        }, _cancelAndErrorClosure(subscription, result));
      } else {
        value = element;
        seenFirst = true;
      }
    });
    return result;
  }
  Future<S> fold<S>(S initialValue, S combine(S previous, T element)) {
    _Future<S> result = _Future<S>();
    S value = initialValue;
    StreamSubscription<T> subscription = this.listen(
      null,
      onError: result._completeError,
      onDone: () {
        result._complete(value);
      },
      cancelOnError: true,
    );
    subscription.onData((T element) {
      _runUserCode(() => combine(value, element), (S newValue) {
        value = newValue;
      }, _cancelAndErrorClosure(subscription, result));
    });
    return result;
  }
  Future<String> join([String separator = ""]) {
    _Future<String> result = _Future<String>();
    StringBuffer buffer = StringBuffer();
    bool first = true;
    StreamSubscription<T> subscription = this.listen(
      null,
      onError: result._completeError,
      onDone: () {
        result._complete(buffer.toString());
      },
      cancelOnError: true,
    );
    subscription.onData(
      separator.isEmpty
          ? (T element) {
              try {
                buffer.write(element);
              } catch (e, s) {
                _cancelAndErrorWithReplacement(subscription, result, e, s);
              }
            }
          : (T element) {
              if (!first) {
                buffer.write(separator);
              }
              first = false;
              try {
                buffer.write(element);
              } catch (e, s) {
                _cancelAndErrorWithReplacement(subscription, result, e, s);
              }
            },
    );
    return result;
  }
  Future<bool> contains(Object? needle) {
    _Future<bool> future = _Future<bool>();
    StreamSubscription<T> subscription = this.listen(
      null,
      onError: future._completeError,
      onDone: () {
        future._complete(false);
      },
      cancelOnError: true,
    );
    subscription.onData((T element) {
      _runUserCode(() => (element == needle), (bool isMatch) {
        if (isMatch) {
          _cancelAndValue(subscription, future, true);
        }
      }, _cancelAndErrorClosure(subscription, future));
    });
    return future;
  }
  Future<void> forEach(void action(T element)) {
    _Future future = _Future();
    StreamSubscription<T> subscription = this.listen(
      null,
      onError: future._completeError,
      onDone: () {
        future._complete(null);
      },
      cancelOnError: true,
    );
    subscription.onData((T element) {
      _runUserCode<void>(
        () => action(element),
        (_) {},
        _cancelAndErrorClosure(subscription, future),
      );
    });
    return future;
  }
  Future<bool> every(bool test(T element)) {
    _Future<bool> future = _Future<bool>();
    StreamSubscription<T> subscription = this.listen(
      null,
      onError: future._completeError,
      onDone: () {
        future._complete(true);
      },
      cancelOnError: true,
    );
    subscription.onData((T element) {
      _runUserCode(() => test(element), (bool isMatch) {
        if (!isMatch) {
          _cancelAndValue(subscription, future, false);
        }
      }, _cancelAndErrorClosure(subscription, future));
    });
    return future;
  }
  Future<bool> any(bool test(T element)) {
    _Future<bool> future = _Future<bool>();
    StreamSubscription<T> subscription = this.listen(
      null,
      onError: future._completeError,
      onDone: () {
        future._complete(false);
      },
      cancelOnError: true,
    );
    subscription.onData((T element) {
      _runUserCode(() => test(element), (bool isMatch) {
        if (isMatch) {
          _cancelAndValue(subscription, future, true);
        }
      }, _cancelAndErrorClosure(subscription, future));
    });
    return future;
  }
  Future<int> get length {
    _Future<int> future = _Future<int>();
    int count = 0;
    this.listen(
      (_) {
        count++;
      },
      onError: future._completeError,
      onDone: () {
        future._complete(count);
      },
      cancelOnError: true,
    );
    return future;
  }
  Future<bool> get isEmpty {
    _Future<bool> future = _Future<bool>();
    StreamSubscription<T> subscription = this.listen(
      null,
      onError: future._completeError,
      onDone: () {
        future._complete(true);
      },
      cancelOnError: true,
    );
    subscription.onData((_) {
      _cancelAndValue(subscription, future, false);
    });
    return future;
  }
  Stream<R> cast<R>() => Stream.castFrom<T, R>(this);
  Future<List<T>> toList() {
    List<T> result = <T>[];
    _Future<List<T>> future = _Future<List<T>>();
    this.listen(
      (T data) {
        result.add(data);
      },
      onError: future._completeError,
      onDone: () {
        future._complete(result);
      },
      cancelOnError: true,
    );
    return future;
  }
  Future<Set<T>> toSet() {
    Set<T> result = Set<T>();
    _Future<Set<T>> future = _Future<Set<T>>();
    this.listen(
      (T data) {
        result.add(data);
      },
      onError: future._completeError,
      onDone: () {
        future._complete(result);
      },
      cancelOnError: true,
    );
    return future;
  }
  Future<E> drain<E>([E? futureValue]) {
    if (futureValue == null) {
      futureValue = futureValue as E;
    }
    return listen(null, cancelOnError: true).asFuture<E>(futureValue);
  }
  Stream<T> take(int count) {
    return _TakeStream<T>(this, count);
  }
  Stream<T> takeWhile(bool test(T element)) {
    return _TakeWhileStream<T>(this, test);
  }
  Stream<T> skip(int count) {
    return _SkipStream<T>(this, count);
  }
  Stream<T> skipWhile(bool test(T element)) {
    return _SkipWhileStream<T>(this, test);
  }
  Stream<T> distinct([bool equals(T previous, T next)?]) {
    return _DistinctStream<T>(this, equals);
  }
  Future<T> get first {
    _Future<T> future = _Future<T>();
    StreamSubscription<T> subscription = this.listen(
      null,
      onError: future._completeError,
      onDone: () {
        var stack = StackTrace.empty;
        var error = IterableElementError.noElement();
        _trySetStackTrace(error, stack);
        _completeWithErrorCallback(future, error, stack);
      },
      cancelOnError: true,
    );
    subscription.onData((T value) {
      _cancelAndValue(subscription, future, value);
    });
    return future;
  }
  Future<T> get last {
    _Future<T> future = _Future<T>();
    late T result;
    bool foundResult = false;
    listen(
      (T value) {
        foundResult = true;
        result = value;
      },
      onError: future._completeError,
      onDone: () {
        if (foundResult) {
          future._complete(result);
          return;
        }
        var stack = StackTrace.empty;
        var error = IterableElementError.noElement();
        _trySetStackTrace(error, stack);
        _completeWithErrorCallback(future, error, stack);
      },
      cancelOnError: true,
    );
    return future;
  }
  Future<T> get single {
    _Future<T> future = _Future<T>();
    late T result;
    bool foundResult = false;
    StreamSubscription<T> subscription = this.listen(
      null,
      onError: future._completeError,
      onDone: () {
        if (foundResult) {
          future._complete(result);
          return;
        }
        var stack = StackTrace.empty;
        var error = IterableElementError.noElement();
        _trySetStackTrace(error, stack);
        _completeWithErrorCallback(future, error, stack);
      },
      cancelOnError: true,
    );
    subscription.onData((T value) {
      if (foundResult) {
        var stack = StackTrace.empty;
        var error = IterableElementError.tooMany();
        _trySetStackTrace(error, stack);
        _cancelAndErrorWithReplacement(subscription, future, error, stack);
        return;
      }
      foundResult = true;
      result = value;
    });
    return future;
  }
  Future<T> firstWhere(bool test(T element), {T orElse()?}) {
    _Future<T> future = _Future();
    StreamSubscription<T> subscription = this.listen(
      null,
      onError: future._completeError,
      onDone: () {
        if (orElse != null) {
          _runUserCode(orElse, future._complete, future._completeError);
          return;
        }
        var stack = StackTrace.empty;
        var error = IterableElementError.noElement();
        _trySetStackTrace(error, stack);
        _completeWithErrorCallback(future, error, stack);
      },
      cancelOnError: true,
    );
    subscription.onData((T value) {
      _runUserCode(() => test(value), (bool isMatch) {
        if (isMatch) {
          _cancelAndValue(subscription, future, value);
        }
      }, _cancelAndErrorClosure(subscription, future));
    });
    return future;
  }
  Future<T> lastWhere(bool test(T element), {T orElse()?}) {
    _Future<T> future = _Future();
    late T result;
    bool foundResult = false;
    StreamSubscription<T> subscription = this.listen(
      null,
      onError: future._completeError,
      onDone: () {
        if (foundResult) {
          future._complete(result);
          return;
        }
        if (orElse != null) {
          _runUserCode(orElse, future._complete, future._completeError);
          return;
        }
        var stack = StackTrace.empty;
        var error = IterableElementError.noElement();
        _trySetStackTrace(error, stack);
        _completeWithErrorCallback(future, error, stack);
      },
      cancelOnError: true,
    );
    subscription.onData((T value) {
      _runUserCode(() => test(value), (bool isMatch) {
        if (isMatch) {
          foundResult = true;
          result = value;
        }
      }, _cancelAndErrorClosure(subscription, future));
    });
    return future;
  }
  Future<T> singleWhere(bool test(T element), {T orElse()?}) {
    _Future<T> future = _Future<T>();
    late T result;
    bool foundResult = false;
    StreamSubscription<T> subscription = this.listen(
      null,
      onError: future._completeError,
      onDone: () {
        if (foundResult) {
          future._complete(result);
          return;
        }
        if (orElse != null) {
          _runUserCode(orElse, future._complete, future._completeError);
          return;
        }
        var stack = StackTrace.empty;
        var error = IterableElementError.noElement();
        _trySetStackTrace(error, stack);
        _completeWithErrorCallback(future, error, stack);
      },
      cancelOnError: true,
    );
    subscription.onData((T value) {
      _runUserCode(() => test(value), (bool isMatch) {
        if (isMatch) {
          if (foundResult) {
            var stack = StackTrace.empty;
            var error = IterableElementError.tooMany();
            _trySetStackTrace(error, stack);
            _cancelAndErrorWithReplacement(subscription, future, error, stack);
            return;
          }
          foundResult = true;
          result = value;
        }
      }, _cancelAndErrorClosure(subscription, future));
    });
    return future;
  }
  Future<T> elementAt(int index) {
    RangeError.checkNotNegative(index, "index");
    _Future<T> result = _Future<T>();
    int elementIndex = 0;
    StreamSubscription<T> subscription;
    subscription = this.listen(
      null,
      onError: result._completeError,
      onDone: () {
        result._completeError(
          IndexError.withLength(
            index,
            elementIndex,
            indexable: this,
            name: "index",
          ),
          StackTrace.empty,
        );
      },
      cancelOnError: true,
    );
    subscription.onData((T value) {
      if (index == elementIndex) {
        _cancelAndValue(subscription, result, value);
        return;
      }
      elementIndex += 1;
    });
    return result;
  }
  Stream<T> timeout(Duration timeLimit, {void onTimeout(EventSink<T> sink)?}) {
    _StreamControllerBase<T> controller;
    if (isBroadcast) {
      controller = _SyncBroadcastStreamController<T>(null, null);
    } else {
      controller = _SyncStreamController<T>(null, null, null, null);
    }
    _TimerCallback timeoutCallback;
    if (onTimeout == null) {
      timeoutCallback = () {
        controller.addError(
          TimeoutException("No stream event", timeLimit),
          null,
        );
      };
    } else {
      var registeredOnTimeout = onTimeout;
      var wrapper = _ControllerEventSinkWrapper<T>(null);
      timeoutCallback = () {
        wrapper._sink = controller;
        _runUnaryGuarded(registeredOnTimeout, wrapper);
        wrapper._sink = null;
      };
    }
    controller.onListen = () {
      Timer timer = Timer(timeLimit, timeoutCallback);
      var subscription = this.listen(null);
      subscription
        ..onData((T event) {
          timer.cancel();
          timer = Timer(timeLimit, timeoutCallback);
          controller.add(event);
        })
        ..onError((Object error, StackTrace stackTrace) {
          timer.cancel();
          timer = Timer(timeLimit, timeoutCallback);
          controller._addError(
            error,
            stackTrace,
          );
        })
        ..onDone(() {
          timer.cancel();
          controller.close();
        });
      controller.onCancel = () {
        timer.cancel();
        return subscription.cancel();
      };
      if (!isBroadcast) {
        controller
          ..onPause = () {
            timer.cancel();
            subscription.pause();
          }
          ..onResume = () {
            subscription.resume();
            timer = Timer(timeLimit, timeoutCallback);
          };
      }
    };
    return controller.stream;
  }
}
abstract interface class StreamSubscription<T> {
  Future<void> cancel();
  void onData(void handleData(T data)?);
  void onError(Function? handleError);
  void onDone(void handleDone()?);
  void pause([Future<void>? resumeSignal]);
  void resume();
  bool get isPaused;
  Future<E> asFuture<E>([E? futureValue]);
}
abstract interface class EventSink<T> implements Sink<T> {
  void add(T event);
  void addError(Object error, [StackTrace? stackTrace]);
  void close();
}
class StreamView<T> extends Stream<T> {
  final Stream<T> _stream;
  const StreamView(Stream<T> stream) : _stream = stream;
  bool get isBroadcast => _stream.isBroadcast;
  Stream<T> asBroadcastStream({
    void onListen(StreamSubscription<T> subscription)?,
    void onCancel(StreamSubscription<T> subscription)?,
  }) => _stream.asBroadcastStream(onListen: onListen, onCancel: onCancel);
  StreamSubscription<T> listen(
    void onData(T value)?, {
    Function? onError,
    void onDone()?,
    bool? cancelOnError,
  }) {
    return _stream.listen(
      onData,
      onError: onError,
      onDone: onDone,
      cancelOnError: cancelOnError,
    );
  }
}
abstract interface class StreamConsumer<S> {
  Future addStream(Stream<S> stream);
  Future close();
}
abstract interface class StreamSink<S>
    implements EventSink<S>, StreamConsumer<S> {
  Future close();
  Future get done;
}
abstract interface class StreamTransformer<S, T> {
  const factory StreamTransformer(
    StreamSubscription<T> onListen(Stream<S> stream, bool cancelOnError),
  ) = _StreamSubscriptionTransformer<S, T>;
  factory StreamTransformer.fromHandlers({
    void handleData(S data, EventSink<T> sink)?,
    void handleError(Object error, StackTrace stackTrace, EventSink<T> sink)?,
    void handleDone(EventSink<T> sink)?,
  }) = _StreamHandlerTransformer<S, T>;
  factory StreamTransformer.fromBind(Stream<T> Function(Stream<S>) bind) =
      _StreamBindTransformer<S, T>;
  static StreamTransformer<TS, TT> castFrom<SS, ST, TS, TT>(
    StreamTransformer<SS, ST> source,
  ) {
    return CastStreamTransformer<SS, ST, TS, TT>(source);
  }
  Stream<T> bind(Stream<S> stream);
  StreamTransformer<RS, RT> cast<RS, RT>();
}
abstract class StreamTransformerBase<S, T> implements StreamTransformer<S, T> {
  const StreamTransformerBase();
  StreamTransformer<RS, RT> cast<RS, RT>() =>
      StreamTransformer.castFrom<S, T, RS, RT>(this);
}
abstract interface class StreamIterator<T> {
  factory StreamIterator(Stream<T> stream) =>
      _StreamIterator<T>(stream);
  Future<bool> moveNext();
  T get current;
  Future cancel();
}
class _ControllerEventSinkWrapper<T> implements EventSink<T> {
  EventSink? _sink;
  _ControllerEventSinkWrapper(this._sink);
  EventSink _ensureSink() {
    var sink = _sink;
    if (sink == null) throw StateError("Sink not available");
    return sink;
  }
  void add(T data) {
    _ensureSink().add(data);
  }
  void addError(error, [StackTrace? stackTrace]) {
    _ensureSink().addError(error, stackTrace);
  }
  void close() {
    _ensureSink().close();
  }
}
abstract interface class MultiStreamController<T>
    implements StreamController<T> {
  void addSync(T value);
  void addErrorSync(Object error, [StackTrace? stackTrace]);
  void closeSync();
}
abstract class _EventSink<T> {
  void _add(T data);
  void _addError(Object error, StackTrace stackTrace);
  void _close();
}
abstract class _EventDispatch<T> {
  void _sendData(T data);
  void _sendError(Object error, StackTrace stackTrace);
  void _sendDone();
}
class _BufferingStreamSubscription<T>
    implements StreamSubscription<T>, _EventSink<T>, _EventDispatch<T> {
  static const int _STATE_CANCEL_ON_ERROR = 1 << 0;
  static const int _STATE_CLOSED = 1 << 1;
  static const int _STATE_INPUT_PAUSED = 1 << 2;
  static const int _STATE_CANCELED = 1 << 3;
  static const int _STATE_WAIT_FOR_CANCEL = 1 << 4;
  static const int _STATE_HAS_ERROR_HANDLER = 1 << 5;
  static const int _STATE_IN_CALLBACK = 1 << 6;
  static const int _STATE_HAS_PENDING = 1 << 7;
  static const int _STATE_PAUSE_COUNT = 1 << 8;
  void Function(T) _onData;
  Function _onError;
  void Function() _onDone;
  int _state;
  Future? _cancelFuture;
  _PendingEvents<T>? _pending;
  _BufferingStreamSubscription(
    void onData(T data)?,
    Function? onError,
    void onDone()?,
    bool cancelOnError,
  ) : this.zoned(onData, onError, onDone, cancelOnError);
  _BufferingStreamSubscription.zoned(
    void onData(T data)?,
    Function? onError,
    void onDone()?,
    bool cancelOnError,
  ) : _state =
          (cancelOnError ? _STATE_CANCEL_ON_ERROR : 0) |
          (onError != null ? _STATE_HAS_ERROR_HANDLER : 0),
      _onData = _registerDataHandler<T>(onData),
      _onError = _registerErrorHandler(onError),
      _onDone = _registerDoneHandler(onDone);
  void _setPendingEvents(_PendingEvents<T>? pendingEvents) {
    if (pendingEvents == null) return;
    _pending = pendingEvents;
    if (!pendingEvents.isEmpty) {
      _state |= _STATE_HAS_PENDING;
      pendingEvents.schedule(this);
    }
  }
  void onData(void handleData(T event)?) {
    _onData = _registerDataHandler<T>(handleData);
  }
  static void Function(T) _registerDataHandler<T>(
    void Function(T)? handleData,
  ) {
    return handleData ?? _nullDataHandler;
  }
  void onError(Function? handleError) {
    if (handleError == null) {
      _state &= ~_STATE_HAS_ERROR_HANDLER;
    } else {
      _state |= _STATE_HAS_ERROR_HANDLER;
    }
    _onError = _registerErrorHandler(handleError);
  }
  static Function _registerErrorHandler(Function? handleError) {
    handleError ??= _nullErrorHandler;
    if (handleError is void Function(Object, StackTrace)) {
      return handleError;
    }
    if (handleError is void Function(Object)) {
      return handleError;
    }
    throw new ArgumentError(
      "handleError callback must take either an Object "
      "(the error), or both an Object (the error) and a StackTrace.",
    );
  }
  void onDone(void handleDone()?) {
    _onDone = _registerDoneHandler(handleDone);
  }
  static void Function() _registerDoneHandler(
    void Function()? handleDone,
  ) {
    return handleDone ?? _nullDoneHandler;
  }
  void pause([Future<void>? resumeSignal]) {
    if (_isCanceled) return;
    bool wasPaused = _isPaused;
    bool wasInputPaused = _isInputPaused;
    _state = (_state + _STATE_PAUSE_COUNT) | _STATE_INPUT_PAUSED;
    resumeSignal?.whenComplete(resume);
    if (!wasPaused) _pending?.cancelSchedule();
    if (!wasInputPaused && !_inCallback) _guardCallback(_onPause);
  }
  void resume() {
    if (_isCanceled) return;
    if (_isPaused) {
      _decrementPauseCount();
      if (!_isPaused) {
        if (_hasPending && !_pending!.isEmpty) {
          _pending!.schedule(this);
        } else {
          _state &= ~_STATE_INPUT_PAUSED;
          if (!_inCallback) _guardCallback(_onResume);
        }
      }
    }
  }
  Future cancel() {
    _state &= ~_STATE_WAIT_FOR_CANCEL;
    if (!_isCanceled) {
      _cancel();
    }
    return _cancelFuture ?? _nullFuture;
  }
  Future<E> asFuture<E>([E? futureValue]) {
    E resultValue;
    if (futureValue == null) {
      if (null is! E) {
        throw ArgumentError.notNull("futureValue");
      }
      resultValue = futureValue as dynamic;
    } else {
      resultValue = futureValue;
    }
    _Future<E> result = new _Future<E>();
    _onDone = () {
      result._complete(resultValue);
    };
    _state |= _STATE_HAS_ERROR_HANDLER;
    _onError = (Object error, StackTrace stackTrace) {
      Future cancelFuture = cancel();
      if (!identical(cancelFuture, _nullFuture)) {
        cancelFuture.whenComplete(() {
          result._completeError(error, stackTrace);
        });
      } else {
        result._completeError(error, stackTrace);
      }
    };
    return result;
  }
  bool get _isInputPaused => (_state & _STATE_INPUT_PAUSED) != 0;
  bool get _isClosed => (_state & _STATE_CLOSED) != 0;
  bool get _isCanceled => (_state & _STATE_CANCELED) != 0;
  bool get _waitsForCancel => (_state & _STATE_WAIT_FOR_CANCEL) != 0;
  bool get _inCallback => (_state & _STATE_IN_CALLBACK) != 0;
  bool get _hasPending => (_state & _STATE_HAS_PENDING) != 0;
  bool get _isPaused => _state >= _STATE_PAUSE_COUNT;
  bool get _canFire => _state < _STATE_IN_CALLBACK;
  bool get _mayResumeInput => !_isPaused && (_pending?.isEmpty ?? true);
  bool get _cancelOnError => (_state & _STATE_CANCEL_ON_ERROR) != 0;
  bool get isPaused => _isPaused;
  void _cancel() {
    _state |= _STATE_CANCELED;
    if (_hasPending) {
      _pending!.cancelSchedule();
    }
    if (!_inCallback) _pending = null;
    _cancelFuture = _onCancel();
  }
  void _decrementPauseCount() {
    _state -= _STATE_PAUSE_COUNT;
  }
  void _add(T data) {
    if (_isCanceled) return;
    if (_canFire) {
      _sendData(data);
    } else {
      _addPending(new _DelayedData<T>(data));
    }
  }
  void _addError(Object error, StackTrace stackTrace) {
    _trySetStackTrace(error, stackTrace);
    if (_isCanceled) return;
    if (_canFire) {
      _sendError(error, stackTrace);
    } else {
      _addPending(new _DelayedError(error, stackTrace));
    }
  }
  void _close() {
    if (_isCanceled) return;
    _state |= _STATE_CLOSED;
    if (_canFire) {
      _sendDone();
    } else {
      _addPending(const _DelayedDone());
    }
  }
  void _onPause() {
  }
  void _onResume() {
  }
  Future<void>? _onCancel() {
    return null;
  }
  void _addPending(_DelayedEvent event) {
    var pending = _pending ??= _PendingEvents<T>();
    pending.add(event);
    if (!_hasPending) {
      _state |= _STATE_HAS_PENDING;
      if (!_isPaused) {
        pending.schedule(this);
      }
    }
  }
  void _sendData(T data) {
    bool wasInputPaused = _isInputPaused;
    _state |= _STATE_IN_CALLBACK;
    _runUnaryGuarded(_onData, data);
    _state &= ~_STATE_IN_CALLBACK;
    _checkState(wasInputPaused);
  }
  void _sendError(Object error, StackTrace stackTrace) {
    bool wasInputPaused = _isInputPaused;
    void sendError() {
      if (_isCanceled && !_waitsForCancel) return;
      _state |= _STATE_IN_CALLBACK;
      var onError = _onError;
      if (onError is void Function(Object, StackTrace)) {
        _runBinaryGuarded(onError, error, stackTrace);
      } else {
        _runUnaryGuarded(_onError as dynamic, error);
      }
      _state &= ~_STATE_IN_CALLBACK;
    }
    if (_cancelOnError) {
      _state |= _STATE_WAIT_FOR_CANCEL;
      _cancel();
      var cancelFuture = _cancelFuture;
      if (cancelFuture != null &&
          !identical(cancelFuture, _nullFuture)) {
        cancelFuture.whenComplete(sendError);
      } else {
        sendError();
      }
    } else {
      sendError();
      _checkState(wasInputPaused);
    }
  }
  void _sendDone() {
    void sendDone() {
      if (!_waitsForCancel) return;
      _state |= (_STATE_CANCELED | _STATE_CLOSED | _STATE_IN_CALLBACK);
      _runGuarded(_onDone);
      _state &= ~_STATE_IN_CALLBACK;
    }
    _cancel();
    _state |= _STATE_WAIT_FOR_CANCEL;
    var cancelFuture = _cancelFuture;
    if (cancelFuture != null && !identical(cancelFuture, _nullFuture)) {
      cancelFuture.whenComplete(sendDone);
    } else {
      sendDone();
    }
  }
  void _guardCallback(void Function() callback) {
    bool wasInputPaused = _isInputPaused;
    _state |= _STATE_IN_CALLBACK;
    callback();
    _state &= ~_STATE_IN_CALLBACK;
    _checkState(wasInputPaused);
  }
  void _checkState(bool wasInputPaused) {
    if (_hasPending && _pending!.isEmpty) {
      _state &= ~_STATE_HAS_PENDING;
      if (_isInputPaused && _mayResumeInput) {
        _state &= ~_STATE_INPUT_PAUSED;
      }
    }
    while (true) {
      if (_isCanceled) {
        _pending = null;
        return;
      }
      bool isInputPaused = _isInputPaused;
      if (wasInputPaused == isInputPaused) break;
      _state ^= _STATE_IN_CALLBACK;
      if (isInputPaused) {
        _onPause();
      } else {
        _onResume();
      }
      _state &= ~_STATE_IN_CALLBACK;
      wasInputPaused = isInputPaused;
    }
    if (_hasPending && !_isPaused) {
      _pending!.schedule(this);
    }
  }
}
abstract class _StreamImpl<T> extends Stream<T> {
  StreamSubscription<T> listen(
    void onData(T data)?, {
    Function? onError,
    void onDone()?,
    bool? cancelOnError,
  }) {
    cancelOnError ??= false;
    StreamSubscription<T> subscription = _createSubscription(
      onData,
      onError,
      onDone,
      cancelOnError,
    );
    _onListen(subscription);
    return subscription;
  }
  StreamSubscription<T> _createSubscription(
    void onData(T data)?,
    Function? onError,
    void onDone()?,
    bool cancelOnError,
  ) {
    return new _BufferingStreamSubscription<T>(
      onData,
      onError,
      onDone,
      cancelOnError,
    );
  }
  void _onListen(StreamSubscription subscription) {}
}
void _nullDataHandler(dynamic value) {}
void _nullErrorHandler(Object error, StackTrace stackTrace) {
  _rootHandleError(error, stackTrace);
}
void _nullDoneHandler() {}
abstract class _DelayedEvent<T> {
  _DelayedEvent? next;
  void perform(_EventDispatch<T> dispatch);
}
class _DelayedData<T> extends _DelayedEvent<T> {
  final T value;
  _DelayedData(this.value);
  void perform(_EventDispatch<T> dispatch) {
    dispatch._sendData(value);
  }
}
class _DelayedError extends _DelayedEvent {
  final Object error;
  final StackTrace stackTrace;
  _DelayedError(this.error, this.stackTrace);
  void perform(_EventDispatch dispatch) {
    dispatch._sendError(error, stackTrace);
  }
}
class _DelayedDone implements _DelayedEvent {
  const _DelayedDone();
  void perform(_EventDispatch dispatch) {
    dispatch._sendDone();
  }
  _DelayedEvent? get next => null;
  void set next(_DelayedEvent? _) {
    throw new StateError("No events after a done.");
  }
}
class _PendingEvents<T> {
  static const int stateUnscheduled = 0;
  static const int stateScheduled = 1;
  static const int stateCanceled = 3;
  int _state = stateUnscheduled;
  _DelayedEvent? firstPendingEvent;
  _DelayedEvent? lastPendingEvent;
  bool get isScheduled => _state == stateScheduled;
  bool get _eventScheduled => _state >= stateScheduled;
  void schedule(_EventDispatch<T> dispatch) {
    if (isScheduled) return;
    if (_eventScheduled) {
      _state = stateScheduled;
      return;
    }
    scheduleMicrotask(() {
      int oldState = _state;
      _state = stateUnscheduled;
      if (oldState == stateCanceled) return;
      handleNext(dispatch);
    });
    _state = stateScheduled;
  }
  void cancelSchedule() {
    if (isScheduled) _state = stateCanceled;
  }
  bool get isEmpty => lastPendingEvent == null;
  void add(_DelayedEvent event) {
    var lastEvent = lastPendingEvent;
    if (lastEvent == null) {
      firstPendingEvent = lastPendingEvent = event;
    } else {
      lastPendingEvent = lastEvent.next = event;
    }
  }
  void handleNext(_EventDispatch<T> dispatch) {
    _DelayedEvent event = firstPendingEvent!;
    _DelayedEvent? nextEvent = event.next;
    firstPendingEvent = nextEvent;
    if (nextEvent == null) {
      lastPendingEvent = null;
    }
    event.perform(dispatch);
  }
  void clear() {
    if (isScheduled) cancelSchedule();
    firstPendingEvent = lastPendingEvent = null;
  }
}
typedef void _BroadcastCallback<T>(StreamSubscription<T> subscription);
class _DoneStreamSubscription<T> implements StreamSubscription<T> {
  static const int _stateReadyToSend = 0;
  static const int _stateScheduled = 1;
  static const int _stateDone = -1;
  static const int _statePausedOnce = 2;
  int _state;
  void Function()? _onDone;
  _DoneStreamSubscription(void Function()? onDone)
    : _state = _stateScheduled {
    scheduleMicrotask(_onMicrotask);
    if (onDone != null) {
      _onDone = onDone;
    }
  }
  bool get isPaused => _state >= _statePausedOnce;
  static bool _isDone(int state) => state < 0;
  static int _incrementPauseCount(int state) => state + _statePausedOnce;
  static int _decrementPauseCount(int state) => state - _statePausedOnce;
  void onData(void handleData(T data)?) {}
  void onError(Function? handleError) {}
  void onDone(void handleDone()?) {
    if (!_isDone(_state)) {
            _onDone = handleDone;
    }
  }
  void pause([Future<void>? resumeSignal]) {
    if (!_isDone(_state)) {
      _state = _incrementPauseCount(_state);
      if (resumeSignal != null) resumeSignal.whenComplete(resume);
    }
  }
  void resume() {
    var resumeState = _decrementPauseCount(_state);
    if (resumeState < 0) return; // Wasn't paused.
    if (resumeState == _stateReadyToSend) {
      _state = _stateScheduled;
      scheduleMicrotask(_onMicrotask);
    } else {
      _state = resumeState;
    }
  }
  Future cancel() {
    _state = _stateDone;
    _onDone = null;
    return _nullFuture;
  }
  Future<E> asFuture<E>([E? futureValue]) {
    E resultValue;
    if (futureValue == null) {
      if (null is! E) {
        throw ArgumentError.notNull("futureValue");
      }
      resultValue = futureValue as dynamic;
    } else {
      resultValue = futureValue;
    }
    _Future<E> result = _Future<E>();
    if (!_isDone(_state)) {
      _onDone = () {
        result._completeWithValue(resultValue);
      };
    }
    return result;
  }
  void _onMicrotask() {
    var unscheduledState = _state - _stateScheduled;
    if (unscheduledState == _stateReadyToSend) {
      _state = _stateDone;
      if (_onDone case var doneHandler?) {
        _onDone = null;
        _runGuarded(doneHandler);
      }
    } else {
      _state = unscheduledState;
    }
  }
}
class _AsBroadcastStream<T> extends Stream<T> {
  final Stream<T> _source;
  final _BroadcastCallback<T>? _onListenHandler;
  final _BroadcastCallback<T>? _onCancelHandler;
  _AsBroadcastStreamController<T>? _controller;
  StreamSubscription<T>? _subscription;
  _AsBroadcastStream(
    this._source,
    void onListenHandler(StreamSubscription<T> subscription)?,
    void onCancelHandler(StreamSubscription<T> subscription)?,
  ) : _onListenHandler = onListenHandler == null
          ? null
          : onListenHandler,
      _onCancelHandler = onCancelHandler == null
          ? null
          : onCancelHandler {
    _controller = new _AsBroadcastStreamController<T>(_onListen, _onCancel);
  }
  bool get isBroadcast => true;
  StreamSubscription<T> listen(
    void onData(T data)?, {
    Function? onError,
    void onDone()?,
    bool? cancelOnError,
  }) {
    var controller = _controller;
    if (controller == null || controller.isClosed) {
      return new _DoneStreamSubscription<T>(onDone);
    }
    _subscription ??= _source.listen(
      controller.add,
      onError: controller.addError,
      onDone: controller.close,
    );
    return controller._subscribe(
      onData,
      onError,
      onDone,
      cancelOnError ?? false,
    );
  }
  void _onCancel() {
    var controller = _controller;
    bool shutdown = (controller == null) || controller.isClosed;
    var cancelHandler = _onCancelHandler;
    if (cancelHandler != null) {
      cancelHandler(new _BroadcastSubscriptionWrapper<T>(this));
    }
    if (shutdown) {
      var subscription = _subscription;
      if (subscription != null) {
        subscription.cancel();
        _subscription = null;
      }
    }
  }
  void _onListen() {
    var listenHandler = _onListenHandler;
    if (listenHandler != null) {
      listenHandler(new _BroadcastSubscriptionWrapper<T>(this));
    }
  }
  void _cancelSubscription() {
    var subscription = _subscription;
    if (subscription != null) {
      _subscription = null;
      _controller = null;
      subscription.cancel();
    }
  }
  void _pauseSubscription(Future<void>? resumeSignal) {
    _subscription?.pause(resumeSignal);
  }
  void _resumeSubscription() {
    _subscription?.resume();
  }
  bool get _isSubscriptionPaused {
    return _subscription?.isPaused ?? false;
  }
}
class _BroadcastSubscriptionWrapper<T> implements StreamSubscription<T> {
  final _AsBroadcastStream _stream;
  _BroadcastSubscriptionWrapper(this._stream);
  void onData(void handleData(T data)?) {
    throw new UnsupportedError(
      "Cannot change handlers of asBroadcastStream source subscription.",
    );
  }
  void onError(Function? handleError) {
    throw new UnsupportedError(
      "Cannot change handlers of asBroadcastStream source subscription.",
    );
  }
  void onDone(void handleDone()?) {
    throw new UnsupportedError(
      "Cannot change handlers of asBroadcastStream source subscription.",
    );
  }
  void pause([Future<void>? resumeSignal]) {
    _stream._pauseSubscription(resumeSignal);
  }
  void resume() {
    _stream._resumeSubscription();
  }
  Future cancel() {
    _stream._cancelSubscription();
    return _nullFuture;
  }
  bool get isPaused {
    return _stream._isSubscriptionPaused;
  }
  Future<E> asFuture<E>([E? futureValue]) {
    throw new UnsupportedError(
      "Cannot change handlers of asBroadcastStream source subscription.",
    );
  }
}
class _StreamIterator<T> implements StreamIterator<T> {
  StreamSubscription<T>? _subscription;
  Object? _stateData;
  bool _hasValue = false;
  _StreamIterator(Stream<T> stream)
    : _stateData = stream;
  T get current {
    if (_hasValue) return _stateData as dynamic;
    return null as dynamic;
  }
  Future<bool> moveNext() {
    var subscription = _subscription;
    if (subscription != null) {
      if (_hasValue) {
        var future = new _Future<bool>();
        _stateData = future;
        _hasValue = false;
        subscription.resume();
        return future;
      }
      throw new StateError("Already waiting for next.");
    }
    return _initializeOrDone();
  }
  Future<bool> _initializeOrDone() {
    var stateData = _stateData;
    if (stateData != null) {
      Stream<T> stream = stateData as dynamic;
      var future = new _Future<bool>();
      _stateData = future;
      var subscription = stream.listen(
        _onData,
        onError: _onError,
        onDone: _onDone,
        cancelOnError: true,
      );
      if (_stateData != null) {
        _subscription = subscription;
      }
      return future;
    }
    return _falseFuture;
  }
  Future cancel() {
    var subscription = _subscription;
    var stateData = _stateData;
    _stateData = null;
    if (subscription != null) {
      _subscription = null;
      if (!_hasValue) {
        _Future<bool> future = stateData as dynamic;
        future._asyncComplete(false);
      } else {
        _hasValue = false;
      }
      return subscription.cancel();
    }
    return _nullFuture;
  }
  void _onData(T data) {
    if (_subscription == null) return;
    _Future<bool> moveNextFuture = _stateData as dynamic;
    _stateData = data;
    _hasValue = true;
    moveNextFuture._complete(true);
    if (_hasValue) _subscription?.pause();
  }
  void _onError(Object error, StackTrace stackTrace) {
    var subscription = _subscription;
    _Future<bool> moveNextFuture = _stateData as dynamic;
    _subscription = null;
    _stateData = null;
    if (subscription != null) {
      moveNextFuture._completeError(error, stackTrace);
    } else {
      moveNextFuture._asyncCompleteError(error, stackTrace);
    }
  }
  void _onDone() {
    var subscription = _subscription;
    _Future<bool> moveNextFuture = _stateData as dynamic;
    _subscription = null;
    _stateData = null;
    if (subscription != null) {
      moveNextFuture._completeWithValue(false);
    } else {
      moveNextFuture._asyncCompleteWithValue(false);
    }
  }
}
class _EmptyStream<T> extends Stream<T> {
  const _EmptyStream({bool broadcast = true}) : isBroadcast = broadcast;
  final bool isBroadcast;
  StreamSubscription<T> listen(
    void Function(T data)? onData, {
    Function? onError,
    void Function()? onDone,
    bool? cancelOnError,
  }) {
    return _DoneStreamSubscription<T>(onDone);
  }
}
class _MultiStream<T> extends Stream<T> {
  final bool isBroadcast;
  final void Function(MultiStreamController<T>) _onListen;
  _MultiStream(this._onListen, this.isBroadcast);
  StreamSubscription<T> listen(
    void onData(T event)?, {
    Function? onError,
    void onDone()?,
    bool? cancelOnError,
  }) {
    var controller = _MultiStreamController<T>();
    controller.onListen = () {
      _onListen(controller);
    };
    return controller._subscribe(
      onData,
      onError,
      onDone,
      cancelOnError ?? false,
    );
  }
}
class _MultiStreamController<T> extends _AsyncStreamController<T>
    implements MultiStreamController<T> {
  _MultiStreamController() : super(null, null, null, null);
  void addSync(T data) {
    if (!_mayAddEvent) throw _badEventState();
    if (hasListener) _subscription._add(data);
  }
  void addErrorSync(Object error, [StackTrace? stackTrace]) {
    if (!_mayAddEvent) throw _badEventState();
    if (hasListener) {
      _subscription._addError(error, stackTrace ?? StackTrace.empty);
    }
  }
  void closeSync() {
    if (isClosed) return;
    if (!_mayAddEvent) throw _badEventState();
    _state |= _StreamController._STATE_CLOSED;
    if (hasListener) _subscription._close();
  }
  Stream<T> get stream {
    throw UnsupportedError("Not available");
  }
}
typedef ControllerCallback = void Function();
typedef ControllerCancelCallback = FutureOr<void> Function();
abstract interface class StreamController<T> implements StreamSink<T> {
  Stream<T> get stream;
  factory StreamController({
    void onListen()?,
    void onPause()?,
    void onResume()?,
    FutureOr<void> onCancel()?,
    bool sync = false,
  }) {
    return sync
        ? _SyncStreamController<T>(onListen, onPause, onResume, onCancel)
        : _AsyncStreamController<T>(onListen, onPause, onResume, onCancel);
  }
  factory StreamController.broadcast({
    void onListen()?,
    void onCancel()?,
    bool sync = false,
  }) {
    return sync
        ? _SyncBroadcastStreamController<T>(onListen, onCancel)
        : _AsyncBroadcastStreamController<T>(onListen, onCancel);
  }
  abstract void Function()? onListen;
  abstract void Function()? onPause;
  abstract void Function()? onResume;
  abstract FutureOr<void> Function()? onCancel;
  StreamSink<T> get sink;
  bool get isClosed;
  bool get isPaused;
  bool get hasListener;
  void add(T event);
  void addError(Object error, [StackTrace? stackTrace]);
  Future close();
  Future get done;
  Future addStream(Stream<T> source, {bool? cancelOnError});
}
abstract interface class SynchronousStreamController<T>
    implements StreamController<T> {
  void add(T data);
  void addError(Object error, [StackTrace? stackTrace]);
  Future close();
}
abstract class _StreamControllerLifecycle<T> {
  StreamSubscription<T> _subscribe(
    void onData(T data)?,
    Function? onError,
    void onDone()?,
    bool cancelOnError,
  );
  void _recordPause(StreamSubscription<T> subscription) {}
  void _recordResume(StreamSubscription<T> subscription) {}
  Future<void>? _recordCancel(StreamSubscription<T> subscription) => null;
}
abstract class _StreamControllerBase<T>
    implements
        StreamController<T>,
        _StreamControllerLifecycle<T>,
        _EventSink<T>,
        _EventDispatch<T> {}
abstract class _StreamController<T> implements _StreamControllerBase<T> {
  static const int _STATE_INITIAL = 0;
  static const int _STATE_SUBSCRIBED = 1;
  static const int _STATE_CANCELED = 2;
  static const int _STATE_SUBSCRIPTION_MASK = 3;
  static const int _STATE_CLOSED = 4;
  static const int _STATE_ADDSTREAM = 8;
  Object? _varData;
  int _state = _STATE_INITIAL;
  _Future<void>? _doneFuture;
  void Function()? onListen;
  void Function()? onPause;
  void Function()? onResume;
  FutureOr<void> Function()? onCancel;
  _StreamController(this.onListen, this.onPause, this.onResume, this.onCancel);
  Stream<T> get stream => _ControllerStream<T>(this);
  StreamSink<T> get sink => _StreamSinkWrapper<T>(this);
  bool get _isCanceled => (_state & _STATE_CANCELED) != 0;
  bool get hasListener => (_state & _STATE_SUBSCRIBED) != 0;
  bool get _isInitialState =>
      (_state & _STATE_SUBSCRIPTION_MASK) == _STATE_INITIAL;
  bool get isClosed => (_state & _STATE_CLOSED) != 0;
  bool get isPaused =>
      hasListener ? _subscription._isInputPaused : !_isCanceled;
  bool get _isAddingStream => (_state & _STATE_ADDSTREAM) != 0;
  bool get _mayAddEvent => (_state < _STATE_CLOSED);
  _PendingEvents<T>? get _pendingEvents {
    if (!_isAddingStream) {
      return _varData as dynamic;
    }
    _StreamControllerAddStreamState<T> state = _varData as dynamic;
    return state._varData;
  }
  _PendingEvents<T> _ensurePendingEvents() {
    if (!_isAddingStream) {
      Object? events = _varData;
      if (events == null) {
        _varData = events = _PendingEvents<T>();
      }
      return events as dynamic;
    }
    _StreamControllerAddStreamState<T> state = _varData as dynamic;
    Object? events = state._varData;
    if (events == null) {
      state._varData = events = _PendingEvents<T>();
    }
    return events as dynamic;
  }
  _ControllerSubscription<T> get _subscription {
    Object? varData = _varData;
    if (_isAddingStream) {
      _StreamControllerAddStreamState<Object?> streamState = varData as dynamic;
      varData = streamState._varData;
    }
    return varData as dynamic;
  }
  Error _badEventState() {
    if (isClosed) {
      return StateError("Cannot add event after closing");
    }
    return StateError("Cannot add event while adding a stream");
  }
  Future addStream(Stream<T> source, {bool? cancelOnError}) {
    if (!_mayAddEvent) throw _badEventState();
    if (_isCanceled) return _Future.immediate(null);
    _StreamControllerAddStreamState<T> addState =
        _StreamControllerAddStreamState<T>(
          this,
          _varData,
          source,
          cancelOnError ?? false,
        );
    _varData = addState;
    _state |= _STATE_ADDSTREAM;
    return addState.addStreamFuture;
  }
  Future<void> get done => _ensureDoneFuture();
  Future<void> _ensureDoneFuture() =>
      _doneFuture ??= _isCanceled ? _nullFuture : _Future<void>();
  void add(T value) {
    if (!_mayAddEvent) throw _badEventState();
    _add(value);
  }
  void addError(Object error, [StackTrace? stackTrace]) {
    if (!_mayAddEvent) throw _badEventState();
    AsyncError(:error, :stackTrace) = _interceptUserError(error, stackTrace);
    _addError(error, stackTrace);
  }
  Future close() {
    if (isClosed) {
      return _ensureDoneFuture();
    }
    if (!_mayAddEvent) throw _badEventState();
    _closeUnchecked();
    return _ensureDoneFuture();
  }
  void _closeUnchecked() {
    _state |= _STATE_CLOSED;
    if (hasListener) {
      _sendDone();
    } else if (_isInitialState) {
      _ensurePendingEvents().add(const _DelayedDone());
    }
  }
  void _add(T value) {
    if (hasListener) {
      _sendData(value);
    } else if (_isInitialState) {
      _ensurePendingEvents().add(_DelayedData<T>(value));
    }
  }
  void _addError(Object error, StackTrace stackTrace) {
    if (hasListener) {
      _sendError(error, stackTrace);
    } else if (_isInitialState) {
      _ensurePendingEvents().add(_DelayedError(error, stackTrace));
    }
  }
  void _close() {
    _StreamControllerAddStreamState<T> addState = _varData as dynamic;
    _varData = addState._varData;
    _state &= ~_STATE_ADDSTREAM;
    addState.complete();
  }
  StreamSubscription<T> _subscribe(
    void onData(T data)?,
    Function? onError,
    void onDone()?,
    bool cancelOnError,
  ) {
    if (!_isInitialState) {
      throw StateError("Stream has already been listened to.");
    }
    _ControllerSubscription<T> subscription = _ControllerSubscription<T>(
      this,
      onData,
      onError,
      onDone,
      cancelOnError,
    );
    _PendingEvents<T>? pendingEvents = _pendingEvents;
    _state |= _STATE_SUBSCRIBED;
    if (_isAddingStream) {
      _StreamControllerAddStreamState<T> addState = _varData as dynamic;
      addState._varData = subscription;
      addState.resume();
    } else {
      _varData = subscription;
    }
    subscription._setPendingEvents(pendingEvents);
    subscription._guardCallback(() {
      _runGuarded(onListen);
    });
    return subscription;
  }
  Future<void>? _recordCancel(StreamSubscription<T> subscription) {
    Future<void>? result;
    if (_isAddingStream) {
      _StreamControllerAddStreamState<T> addState = _varData as dynamic;
      result = addState.cancel();
    }
    _varData = null;
    _state =
        (_state & ~(_STATE_SUBSCRIBED | _STATE_ADDSTREAM)) | _STATE_CANCELED;
    var onCancel = this.onCancel;
    if (onCancel != null) {
      if (result == null) {
        try {
          var cancelResult = onCancel();
          if (cancelResult is Future<void>) {
            result = cancelResult;
          }
        } catch (e, s) {
          result = _Future().._asyncCompleteError(e, s);
        }
      } else {
        result = result.whenComplete(onCancel);
      }
    }
    void complete() {
      var doneFuture = _doneFuture;
      if (doneFuture != null && doneFuture._mayComplete) {
        doneFuture._asyncComplete(null);
      }
    }
    if (result != null) {
      result = result.whenComplete(complete);
    } else {
      complete();
    }
    return result;
  }
  void _recordPause(StreamSubscription<T> subscription) {
    if (_isAddingStream) {
      _StreamControllerAddStreamState<T> addState = _varData as dynamic;
      addState.pause();
    }
    _runGuarded(onPause);
  }
  void _recordResume(StreamSubscription<T> subscription) {
    if (_isAddingStream) {
      _StreamControllerAddStreamState<T> addState = _varData as dynamic;
      addState.resume();
    }
    _runGuarded(onResume);
  }
}
mixin _SyncStreamControllerDispatch<T>
    implements _StreamController<T>, SynchronousStreamController<T> {
  void _sendData(T data) {
    _subscription._add(data);
  }
  void _sendError(Object error, StackTrace stackTrace) {
    _subscription._addError(error, stackTrace);
  }
  void _sendDone() {
    _subscription._close();
  }
}
mixin _AsyncStreamControllerDispatch<T> implements _StreamController<T> {
  void _sendData(T data) {
    _subscription._addPending(_DelayedData<T>(data));
  }
  void _sendError(Object error, StackTrace stackTrace) {
    _subscription._addPending(_DelayedError(error, stackTrace));
  }
  void _sendDone() {
    _subscription._addPending(const _DelayedDone());
  }
}
class _AsyncStreamController<T> = _StreamController<T>
    with _AsyncStreamControllerDispatch<T>;
class _SyncStreamController<T> = _StreamController<T>
    with _SyncStreamControllerDispatch<T>;
void _runGuarded(void Function()? notificationHandler) {
  if (notificationHandler == null) return;
  try {
    notificationHandler();
  } catch (e, s) {
    _rootHandleError(e, s);
  }
}
class _ControllerStream<T> extends _StreamImpl<T> {
  _StreamControllerLifecycle<T> _controller;
  _ControllerStream(this._controller);
  StreamSubscription<T> _createSubscription(
    void onData(T data)?,
    Function? onError,
    void onDone()?,
    bool cancelOnError,
  ) => _controller._subscribe(onData, onError, onDone, cancelOnError);
  int get hashCode => _controller.hashCode ^ 0x35323532;
  bool operator ==(Object other) {
    if (identical(this, other)) return true;
    return other is _ControllerStream &&
        identical(other._controller, this._controller);
  }
}
class _ControllerSubscription<T> extends _BufferingStreamSubscription<T> {
  final _StreamControllerLifecycle<T> _controller;
  _ControllerSubscription(
    this._controller,
    void onData(T data)?,
    Function? onError,
    void onDone()?,
    bool cancelOnError,
  ) : super(onData, onError, onDone, cancelOnError);
  Future<void>? _onCancel() {
    return _controller._recordCancel(this);
  }
  void _onPause() {
    _controller._recordPause(this);
  }
  void _onResume() {
    _controller._recordResume(this);
  }
}
class _StreamSinkWrapper<T> implements StreamSink<T> {
  final StreamController _target;
  _StreamSinkWrapper(this._target);
  void add(T data) {
    _target.add(data);
  }
  void addError(Object error, [StackTrace? stackTrace]) {
    _target.addError(error, stackTrace);
  }
  Future close() => _target.close();
  Future addStream(Stream<T> source) => _target.addStream(source);
  Future get done => _target.done;
}
class _AddStreamState<T> {
  final _Future addStreamFuture;
  final StreamSubscription addSubscription;
  _AddStreamState(
    _EventSink<T> controller,
    Stream<T> source,
    bool cancelOnError,
  ) : addStreamFuture = _Future(),
      addSubscription = source.listen(
        controller._add,
        onError: cancelOnError
            ? makeErrorHandler(controller)
            : controller._addError,
        onDone: controller._close,
        cancelOnError: cancelOnError,
      );
  static makeErrorHandler(_EventSink controller) => (Object e, StackTrace s) {
    controller._addError(e, s);
    controller._close();
  };
  void pause() {
    addSubscription.pause();
  }
  void resume() {
    addSubscription.resume();
  }
  Future<void> cancel() {
    var cancel = addSubscription.cancel();
    if (cancel == null) {
      addStreamFuture._asyncComplete(null);
      return _nullFuture;
    }
    return cancel.whenComplete(() {
      addStreamFuture._asyncComplete(null);
    });
  }
  void complete() {
    addStreamFuture._asyncComplete(null);
  }
}
class _StreamControllerAddStreamState<T> extends _AddStreamState<T> {
  var _varData;
  _StreamControllerAddStreamState(
    _StreamController<T> controller,
    this._varData,
    Stream<T> source,
    bool cancelOnError,
  ) : super(controller, source, cancelOnError) {
    if (controller.isPaused) {
      addSubscription.pause();
    }
  }
}
class _BroadcastStream<T> extends _ControllerStream<T> {
  _BroadcastStream(_StreamControllerLifecycle<T> controller)
    : super(controller);
  bool get isBroadcast => true;
}
class _BroadcastSubscription<T> extends _ControllerSubscription<T> {
  static const int _STATE_EVENT_ID = 1;
  static const int _STATE_FIRING = 2;
  static const int _STATE_REMOVE_AFTER_FIRING = 4;
  int _eventState = 0;
  _BroadcastSubscription<T>? _next;
  _BroadcastSubscription<T>? _previous;
  _BroadcastSubscription(
    _StreamControllerLifecycle<T> controller,
    void onData(T data)?,
    Function? onError,
    void onDone()?,
    bool cancelOnError,
  ) : super(controller, onData, onError, onDone, cancelOnError) {
    _next = _previous = this;
  }
  bool _expectsEvent(int eventId) => (_eventState & _STATE_EVENT_ID) == eventId;
  void _toggleEventId() {
    _eventState ^= _STATE_EVENT_ID;
  }
  bool get _isFiring => (_eventState & _STATE_FIRING) != 0;
  void _setRemoveAfterFiring() {
    _eventState |= _STATE_REMOVE_AFTER_FIRING;
  }
  bool get _removeAfterFiring =>
      (_eventState & _STATE_REMOVE_AFTER_FIRING) != 0;
  void _onPause() {}
  void _onResume() {}
}
abstract class _BroadcastStreamController<T>
    implements _StreamControllerBase<T> {
  static const int _STATE_INITIAL = 0;
  static const int _STATE_EVENT_ID = 1;
  static const int _STATE_FIRING = 2;
  static const int _STATE_CLOSED = 4;
  static const int _STATE_ADDSTREAM = 8;
  void Function()? onListen;
  FutureOr<void> Function()? onCancel;
  int _state;
  _BroadcastSubscription<T>? _firstSubscription;
  _BroadcastSubscription<T>? _lastSubscription;
  _AddStreamState<T>? _addStreamState;
  _Future<void>? _doneFuture;
  _BroadcastStreamController(this.onListen, this.onCancel)
    : _state = _STATE_INITIAL;
  void Function() get onPause {
    throw UnsupportedError(
      "Broadcast stream controllers do not support pause callbacks",
    );
  }
  void set onPause(void onPauseHandler()?) {
    throw UnsupportedError(
      "Broadcast stream controllers do not support pause callbacks",
    );
  }
  void Function() get onResume {
    throw UnsupportedError(
      "Broadcast stream controllers do not support pause callbacks",
    );
  }
  void set onResume(void onResumeHandler()?) {
    throw UnsupportedError(
      "Broadcast stream controllers do not support pause callbacks",
    );
  }
  Stream<T> get stream => _BroadcastStream<T>(this);
  StreamSink<T> get sink => _StreamSinkWrapper<T>(this);
  bool get isClosed => (_state & _STATE_CLOSED) != 0;
  bool get isPaused => false;
  bool get hasListener => !_isEmpty;
  bool get _hasOneListener {
    return identical(_firstSubscription, _lastSubscription);
  }
  bool get _isFiring => (_state & _STATE_FIRING) != 0;
  bool get _isAddingStream => (_state & _STATE_ADDSTREAM) != 0;
  bool get _mayAddEvent => (_state < _STATE_CLOSED);
  _Future<void> _ensureDoneFuture() => _doneFuture ??= _Future<void>();
  bool get _isEmpty => _firstSubscription == null;
  void _addListener(_BroadcastSubscription<T> subscription) {
    subscription._eventState = (_state & _STATE_EVENT_ID);
    _BroadcastSubscription<T>? oldLast = _lastSubscription;
    _lastSubscription = subscription;
    subscription._next = null;
    subscription._previous = oldLast;
    if (oldLast == null) {
      _firstSubscription = subscription;
    } else {
      oldLast._next = subscription;
    }
  }
  void _removeListener(_BroadcastSubscription<T> subscription) {
    _BroadcastSubscription<T>? previous = subscription._previous;
    _BroadcastSubscription<T>? next = subscription._next;
    if (previous == null) {
      _firstSubscription = next;
    } else {
      previous._next = next;
    }
    if (next == null) {
      _lastSubscription = previous;
    } else {
      next._previous = previous;
    }
    subscription._next = subscription._previous = subscription;
  }
  StreamSubscription<T> _subscribe(
    void onData(T data)?,
    Function? onError,
    void onDone()?,
    bool cancelOnError,
  ) {
    if (isClosed) {
      return _DoneStreamSubscription<T>(onDone);
    }
    var subscription = _BroadcastSubscription<T>(
      this,
      onData,
      onError,
      onDone,
      cancelOnError,
    );
    _addListener(subscription);
    if (identical(_firstSubscription, _lastSubscription)) {
      _runGuarded(onListen);
    }
    return subscription;
  }
  Future<void>? _recordCancel(StreamSubscription<T> sub) {
    _BroadcastSubscription<T> subscription = sub as _BroadcastSubscription<T>;
    if (identical(subscription._next, subscription)) return null;
    if (subscription._isFiring) {
      subscription._setRemoveAfterFiring();
    } else {
      _removeListener(subscription);
      if (!_isFiring && _isEmpty) {
        _callOnCancel();
      }
    }
    return null;
  }
  void _recordPause(StreamSubscription<T> subscription) {}
  void _recordResume(StreamSubscription<T> subscription) {}
  Error _addEventError() {
    if (isClosed) {
      return StateError("Cannot add new events after calling close");
    }
    return StateError("Cannot add new events while doing an addStream");
  }
  void add(T data) {
    if (!_mayAddEvent) throw _addEventError();
    _sendData(data);
  }
  void addError(Object error, [StackTrace? stackTrace]) {
    if (!_mayAddEvent) throw _addEventError();
    AsyncError(:error, :stackTrace) = _interceptUserError(error, stackTrace);
    _addError(error, stackTrace);
  }
  Future<void> close() {
    if (isClosed) {
      return _doneFuture!;
    }
    if (!_mayAddEvent) throw _addEventError();
    _state |= _STATE_CLOSED;
    var doneFuture = _ensureDoneFuture();
    _sendDone();
    return doneFuture;
  }
  Future<void> get done => _ensureDoneFuture();
  Future addStream(Stream<T> stream, {bool? cancelOnError}) {
    if (!_mayAddEvent) throw _addEventError();
    _state |= _STATE_ADDSTREAM;
    var addStreamState = _AddStreamState(this, stream, cancelOnError ?? false);
    _addStreamState = addStreamState;
    return addStreamState.addStreamFuture;
  }
  void _add(T data) {
    _sendData(data);
  }
  void _addError(Object error, StackTrace stackTrace) {
    _sendError(error, stackTrace);
  }
  void _close() {
    _AddStreamState addState = _addStreamState!;
    _addStreamState = null;
    _state &= ~_STATE_ADDSTREAM;
    addState.complete();
  }
  void _forEachListener(
    void action(_BufferingStreamSubscription<T> subscription),
  ) {
    if (_isFiring) {
      throw StateError(
        "Cannot fire new event. Controller is already firing an event",
      );
    }
    if (_isEmpty) return;
    int id = (_state & _STATE_EVENT_ID);
    _state ^= _STATE_EVENT_ID | _STATE_FIRING;
    _BroadcastSubscription<T>? subscription = _firstSubscription;
    while (subscription != null) {
      if (subscription._expectsEvent(id)) {
        subscription._eventState |= _BroadcastSubscription._STATE_FIRING;
        action(subscription);
        subscription._toggleEventId();
        _BroadcastSubscription<T>? next = subscription._next;
        if (subscription._removeAfterFiring) {
          _removeListener(subscription);
        }
        subscription._eventState &= ~_BroadcastSubscription._STATE_FIRING;
        subscription = next;
      } else {
        subscription = subscription._next;
      }
    }
    _state &= ~_STATE_FIRING;
    if (_isEmpty) {
      _callOnCancel();
    }
  }
  void _callOnCancel() {
    if (isClosed) {
      var doneFuture = _doneFuture!;
      if (doneFuture._mayComplete) {
        doneFuture._asyncComplete(null);
      }
    }
    _runGuarded(onCancel);
  }
}
class _SyncBroadcastStreamController<T> extends _BroadcastStreamController<T>
    implements SynchronousStreamController<T> {
  _SyncBroadcastStreamController(void onListen()?, void onCancel()?)
    : super(onListen, onCancel);
  bool get _mayAddEvent => super._mayAddEvent && !_isFiring;
  _addEventError() {
    if (_isFiring) {
      return StateError(
        "Cannot fire new event. Controller is already firing an event",
      );
    }
    return super._addEventError();
  }
  void _sendData(T data) {
    if (_isEmpty) return;
    if (_hasOneListener) {
      _state |= _BroadcastStreamController._STATE_FIRING;
      _BroadcastSubscription<T> firstSubscription =
          _firstSubscription as dynamic;
      firstSubscription._add(data);
      _state &= ~_BroadcastStreamController._STATE_FIRING;
      if (_isEmpty) {
        _callOnCancel();
      }
      return;
    }
    _forEachListener((_BufferingStreamSubscription<T> subscription) {
      subscription._add(data);
    });
  }
  void _sendError(Object error, StackTrace stackTrace) {
    if (_isEmpty) return;
    _forEachListener((_BufferingStreamSubscription<T> subscription) {
      subscription._addError(error, stackTrace);
    });
  }
  void _sendDone() {
    if (!_isEmpty) {
      _forEachListener((_BufferingStreamSubscription<T> subscription) {
        subscription._close();
      });
    } else {
      _doneFuture!._asyncComplete(null);
    }
  }
}
class _AsyncBroadcastStreamController<T> extends _BroadcastStreamController<T> {
  _AsyncBroadcastStreamController(void onListen()?, void onCancel()?)
    : super(onListen, onCancel);
  void _sendData(T data) {
    for (
      var subscription = _firstSubscription;
      subscription != null;
      subscription = subscription._next
    ) {
      subscription._addPending(_DelayedData<T>(data));
    }
  }
  void _sendError(Object error, StackTrace stackTrace) {
    for (
      var subscription = _firstSubscription;
      subscription != null;
      subscription = subscription._next
    ) {
      subscription._addPending(_DelayedError(error, stackTrace));
    }
  }
  void _sendDone() {
    if (!_isEmpty) {
      for (
        var subscription = _firstSubscription;
        subscription != null;
        subscription = subscription._next
      ) {
        subscription._addPending(const _DelayedDone());
      }
    } else {
      _doneFuture!._asyncComplete(null);
    }
  }
}
class _AsBroadcastStreamController<T> extends _SyncBroadcastStreamController<T>
    implements _EventDispatch<T> {
  _PendingEvents<T>? _pending;
  _AsBroadcastStreamController(void onListen()?, void onCancel()?)
    : super(onListen, onCancel);
  bool get _hasPending {
    var pending = _pending;
    return pending != null && !pending.isEmpty;
  }
  void _addPendingEvent(_DelayedEvent event) {
    (_pending ??= _PendingEvents<T>()).add(event);
  }
  void add(T data) {
    if (!isClosed && _isFiring) {
      _addPendingEvent(_DelayedData<T>(data));
      return;
    }
    super.add(data);
    _flushPending();
  }
  void addError(Object error, [StackTrace? stackTrace]) {
    if (!_mayAddEvent) throw _addEventError();
    AsyncError(:error, :stackTrace) = _interceptUserError(error, stackTrace);
    if (!isClosed && _isFiring) {
      _addPendingEvent(_DelayedError(error, stackTrace));
      return;
    }
    _addError(error, stackTrace);
    _flushPending();
  }
  void _flushPending() {
    var pending = _pending;
    if (pending != null) {
      while (!pending.isEmpty) {
        pending.handleNext(this);
      }
    }
  }
  Future<void> close() {
    if (!isClosed && _isFiring) {
      _addPendingEvent(const _DelayedDone());
      _state |= _BroadcastStreamController._STATE_CLOSED;
      return super.done;
    }
    var result = super.close();
    return result;
  }
  void _callOnCancel() {
    var pending = _pending;
    if (pending != null) {
      pending.clear();
      _pending = null;
    }
    super._callOnCancel();
  }
}
_runUserCode<T>(
  T userCode(),
  onSuccess(T value),
  onError(Object error, StackTrace stackTrace),
) {
  try {
    onSuccess(userCode());
  } catch (error, stackTrace) {
    onError(error, stackTrace);
  }
}
void _cancelAndError(
  StreamSubscription subscription,
  _Future future,
  AsyncError error,
) {
  var cancelFuture = subscription.cancel();
  if (!identical(cancelFuture, _nullFuture)) {
    cancelFuture.whenComplete(() => future._completeErrorObject(error));
  } else {
    future._completeErrorObject(error);
  }
}
void _cancelAndErrorWithReplacement(
  StreamSubscription subscription,
  _Future future,
  Object error,
  StackTrace stackTrace,
) {
  _cancelAndError(
    subscription,
    future,
    _interceptCaughtError(error, stackTrace),
  );
}
void Function(Object error, StackTrace stackTrace) _cancelAndErrorClosure(
  StreamSubscription subscription,
  _Future future,
) {
  return (Object error, StackTrace stackTrace) {
    _cancelAndError(subscription, future, AsyncError(error, stackTrace));
  };
}
void _cancelAndValue(StreamSubscription subscription, _Future future, value) {
  var cancelFuture = subscription.cancel();
  if (!identical(cancelFuture, _nullFuture)) {
    cancelFuture.whenComplete(() => future._complete(value));
  } else {
    future._complete(value);
  }
}
abstract class _ForwardingStream<S, T> extends Stream<T> {
  final Stream<S> _source;
  _ForwardingStream(this._source);
  bool get isBroadcast => _source.isBroadcast;
  StreamSubscription<T> listen(
    void onData(T value)?, {
    Function? onError,
    void onDone()?,
    bool? cancelOnError,
  }) {
    return _createSubscription(onData, onError, onDone, cancelOnError ?? false);
  }
  StreamSubscription<T> _createSubscription(
    void onData(T data)?,
    Function? onError,
    void onDone()?,
    bool cancelOnError,
  ) {
    return new _ForwardingStreamSubscription<S, T>(
      this,
      onData,
      onError,
      onDone,
      cancelOnError,
    );
  }
  void _handleData(S data, _EventSink<T> sink);
  void _handleError(Object error, StackTrace stackTrace, _EventSink<T> sink) {
    sink._addError(error, stackTrace);
  }
  void _handleDone(_EventSink<T> sink) {
    sink._close();
  }
}
class _ForwardingStreamSubscription<S, T>
    extends _BufferingStreamSubscription<T> {
  final _ForwardingStream<S, T> _stream;
  StreamSubscription<S>? _subscription;
  _ForwardingStreamSubscription(
    this._stream,
    void onData(T data)?,
    Function? onError,
    void onDone()?,
    bool cancelOnError,
  ) : super(onData, onError, onDone, cancelOnError) {
    _subscription = _stream._source.listen(
      _handleData,
      onError: _handleError,
      onDone: _handleDone,
    );
  }
  void _add(T data) {
    if (_isClosed) return;
    super._add(data);
  }
  void _addError(Object error, StackTrace stackTrace) {
    if (_isClosed) return;
    super._addError(error, stackTrace);
  }
  void _onPause() {
    _subscription?.pause();
  }
  void _onResume() {
    _subscription?.resume();
  }
  Future<void>? _onCancel() {
    var subscription = _subscription;
    if (subscription != null) {
      _subscription = null;
      return subscription.cancel();
    }
    return null;
  }
  void _handleData(S data) {
    _stream._handleData(data, this);
  }
  void _handleError(error, StackTrace stackTrace) {
    _stream._handleError(error, stackTrace, this);
  }
  void _handleDone() {
    _stream._handleDone(this);
  }
}
void _addErrorWithReplacement(
  _EventSink sink,
  Object error,
  StackTrace stackTrace,
) {
  sink._addError(error, stackTrace);
}
class _WhereStream<T> extends _ForwardingStream<T, T> {
  final bool Function(T) _test;
  _WhereStream(Stream<T> source, bool test(T value))
    : _test = test,
      super(source);
  void _handleData(T inputEvent, _EventSink<T> sink) {
    bool satisfies;
    try {
      satisfies = _test(inputEvent);
    } catch (e, s) {
      _addErrorWithReplacement(sink, e, s);
      return;
    }
    if (satisfies) {
      sink._add(inputEvent);
    }
  }
}
typedef T _Transformation<S, T>(S value);
class _MapStream<S, T> extends _ForwardingStream<S, T> {
  final _Transformation<S, T> _transform;
  _MapStream(Stream<S> source, T transform(S event))
    : this._transform = transform,
      super(source);
  void _handleData(S inputEvent, _EventSink<T> sink) {
    T outputEvent;
    try {
      outputEvent = _transform(inputEvent);
    } catch (e, s) {
      _addErrorWithReplacement(sink, e, s);
      return;
    }
    sink._add(outputEvent);
  }
}
class _ExpandStream<S, T> extends _ForwardingStream<S, T> {
  final _Transformation<S, Iterable<T>> _expand;
  _ExpandStream(Stream<S> source, Iterable<T> expand(S event))
    : this._expand = expand,
      super(source);
  void _handleData(S inputEvent, _EventSink<T> sink) {
    try {
      for (T value in _expand(inputEvent)) {
        sink._add(value);
      }
    } catch (e, s) {
      _addErrorWithReplacement(sink, e, s);
    }
  }
}
class _HandleErrorStream<T> extends _ForwardingStream<T, T> {
  final void Function(Object, StackTrace) _onError;
  final bool Function(Object)? _test;
  _HandleErrorStream(Stream<T> source, this._onError, this._test)
    : super(source);
  void _handleData(T data, _EventSink<T> sink) {
    sink._add(data);
  }
  void _handleError(Object error, StackTrace stackTrace, _EventSink<T> sink) {
    bool matches = true;
    var test = _test;
    if (test != null) {
      try {
        matches = test(error);
      } catch (e, s) {
        _addErrorWithReplacement(sink, e, s);
        return;
      }
    }
    if (matches) {
      try {
        _onError(error, stackTrace);
      } catch (e, s) {
        if (identical(e, error)) {
          sink._addError(error, stackTrace);
        } else {
          _addErrorWithReplacement(sink, e, s);
        }
        return;
      }
    } else {
      sink._addError(error, stackTrace);
    }
  }
}
class _TakeStream<T> extends _ForwardingStream<T, T> {
  final int _count;
  _TakeStream(Stream<T> source, int count) : this._count = count, super(source);
  StreamSubscription<T> _createSubscription(
    void onData(T data)?,
    Function? onError,
    void onDone()?,
    bool cancelOnError,
  ) {
    if (_count == 0) {
      _source.listen(null).cancel();
      return new _DoneStreamSubscription<T>(onDone);
    }
    return new _StateStreamSubscription<int, T>(
      this,
      onData,
      onError,
      onDone,
      cancelOnError,
      _count,
    );
  }
  void _handleData(T inputEvent, _EventSink<T> sink) {
    var subscription = sink as _StateStreamSubscription<int, T>;
    int count = subscription._subState;
    if (count > 0) {
      sink._add(inputEvent);
      count -= 1;
      subscription._subState = count;
      if (count == 0) {
        sink._close();
      }
    }
  }
}
class _StateStreamSubscription<S, T>
    extends _ForwardingStreamSubscription<T, T> {
  S _subState;
  _StateStreamSubscription(
    _ForwardingStream<T, T> stream,
    void onData(T data)?,
    Function? onError,
    void onDone()?,
    bool cancelOnError,
    this._subState,
  ) : super(stream, onData, onError, onDone, cancelOnError);
}
class _TakeWhileStream<T> extends _ForwardingStream<T, T> {
  final bool Function(T) _test;
  _TakeWhileStream(Stream<T> source, bool test(T value))
    : this._test = test,
      super(source);
  void _handleData(T inputEvent, _EventSink<T> sink) {
    bool satisfies;
    try {
      satisfies = _test(inputEvent);
    } catch (e, s) {
      _addErrorWithReplacement(sink, e, s);
      sink._close();
      return;
    }
    if (satisfies) {
      sink._add(inputEvent);
    } else {
      sink._close();
    }
  }
}
class _SkipStream<T> extends _ForwardingStream<T, T> {
  final int _count;
  _SkipStream(Stream<T> source, int count)
    : this._count = count,
      super(source) {
    RangeError.checkNotNegative(count, "count");
  }
  StreamSubscription<T> _createSubscription(
    void onData(T data)?,
    Function? onError,
    void onDone()?,
    bool cancelOnError,
  ) {
    return new _StateStreamSubscription<int, T>(
      this,
      onData,
      onError,
      onDone,
      cancelOnError,
      _count,
    );
  }
  void _handleData(T inputEvent, _EventSink<T> sink) {
    var subscription = sink as _StateStreamSubscription<int, T>;
    int count = subscription._subState;
    if (count > 0) {
      subscription._subState = count - 1;
      return;
    }
    sink._add(inputEvent);
  }
}
class _SkipWhileStream<T> extends _ForwardingStream<T, T> {
  final bool Function(T) _test;
  _SkipWhileStream(Stream<T> source, bool test(T value))
    : this._test = test,
      super(source);
  StreamSubscription<T> _createSubscription(
    void onData(T data)?,
    Function? onError,
    void onDone()?,
    bool cancelOnError,
  ) {
    return new _StateStreamSubscription<bool, T>(
      this,
      onData,
      onError,
      onDone,
      cancelOnError,
      false,
    );
  }
  void _handleData(T inputEvent, _EventSink<T> sink) {
    var subscription = sink as _StateStreamSubscription<bool, T>;
    bool hasFailed = subscription._subState;
    if (hasFailed) {
      sink._add(inputEvent);
      return;
    }
    bool satisfies;
    try {
      satisfies = _test(inputEvent);
    } catch (e, s) {
      _addErrorWithReplacement(sink, e, s);
      subscription._subState = true;
      return;
    }
    if (!satisfies) {
      subscription._subState = true;
      sink._add(inputEvent);
    }
  }
}
class _DistinctStream<T> extends _ForwardingStream<T, T> {
  static final _SENTINEL = new Object();
  final bool Function(T, T)? _equals;
  _DistinctStream(Stream<T> source, bool equals(T a, T b)?)
    : _equals = equals,
      super(source);
  StreamSubscription<T> _createSubscription(
    void onData(T data)?,
    Function? onError,
    void onDone()?,
    bool cancelOnError,
  ) {
    return new _StateStreamSubscription<Object?, T>(
      this,
      onData,
      onError,
      onDone,
      cancelOnError,
      _SENTINEL,
    );
  }
  void _handleData(T inputEvent, _EventSink<T> sink) {
    var subscription = sink as _StateStreamSubscription<Object?, T>;
    var previous = subscription._subState;
    if (identical(previous, _SENTINEL)) {
      subscription._subState = inputEvent;
      sink._add(inputEvent);
    } else {
      T previousEvent = previous as T;
      var equals = _equals;
      bool isEqual;
      try {
        if (equals == null) {
          isEqual = (previousEvent == inputEvent);
        } else {
          isEqual = equals(previousEvent, inputEvent);
        }
      } catch (e, s) {
        _addErrorWithReplacement(sink, e, s);
        return;
      }
      if (!isEqual) {
        sink._add(inputEvent);
        subscription._subState = inputEvent;
      }
    }
  }
}
class _EventSinkWrapper<T> implements EventSink<T> {
  _EventSink<T> _sink;
  _EventSinkWrapper(this._sink);
  void add(T data) {
    _sink._add(data);
  }
  void addError(Object error, [StackTrace? stackTrace]) {
    _sink._addError(error, stackTrace ?? AsyncError.defaultStackTrace(error));
  }
  void close() {
    _sink._close();
  }
}
class _SinkTransformerStreamSubscription<S, T>
    extends _BufferingStreamSubscription<T> {
  late EventSink<S> _transformerSink;
  StreamSubscription<S>? _subscription;
  _SinkTransformerStreamSubscription(
    Stream<S> source,
    _SinkMapper<S, T> mapper,
    void onData(T data)?,
    Function? onError,
    void onDone()?,
    bool cancelOnError,
  )
    : super(onData, onError, onDone, cancelOnError) {
    _transformerSink = mapper(_EventSinkWrapper<T>(this));
    _subscription = source.listen(
      _handleData,
      onError: _handleError,
      onDone: _handleDone,
    );
  }
  void _add(T data) {
    if (_isClosed) {
      throw StateError("Stream is already closed");
    }
    super._add(data);
  }
  void _addError(Object error, StackTrace stackTrace) {
    if (_isClosed) {
      throw StateError("Stream is already closed");
    }
    super._addError(error, stackTrace);
  }
  void _close() {
    if (_isClosed) {
      throw StateError("Stream is already closed");
    }
    super._close();
  }
  void _onPause() {
    _subscription?.pause();
  }
  void _onResume() {
    _subscription?.resume();
  }
  Future<void>? _onCancel() {
    var subscription = _subscription;
    if (subscription != null) {
      _subscription = null;
      return subscription.cancel();
    }
    return null;
  }
  void _handleData(S data) {
    try {
      _transformerSink.add(data);
    } catch (e, s) {
      _addError(e, s);
    }
  }
  void _handleError(Object error, StackTrace stackTrace) {
    try {
      _transformerSink.addError(error, stackTrace);
    } catch (e, s) {
      if (identical(e, error)) {
        _addError(error, stackTrace);
      } else {
        _addError(e, s);
      }
    }
  }
  void _handleDone() {
    try {
      _subscription = null;
      _transformerSink.close();
    } catch (e, s) {
      _addError(e, s);
    }
  }
}
typedef EventSink<S> _SinkMapper<S, T>(EventSink<T> output);
class _StreamSinkTransformer<S, T> extends StreamTransformerBase<S, T> {
  final _SinkMapper<S, T> _sinkMapper;
  const _StreamSinkTransformer(this._sinkMapper);
  Stream<T> bind(Stream<S> stream) =>
      _BoundSinkStream<S, T>(stream, _sinkMapper);
}
class _BoundSinkStream<S, T> extends Stream<T> {
  final _SinkMapper<S, T> _sinkMapper;
  final Stream<S> _stream;
  bool get isBroadcast => _stream.isBroadcast;
  _BoundSinkStream(this._stream, this._sinkMapper);
  StreamSubscription<T> listen(
    void onData(T event)?, {
    Function? onError,
    void onDone()?,
    bool? cancelOnError,
  }) {
    StreamSubscription<T> subscription =
        _SinkTransformerStreamSubscription<S, T>(
          _stream,
          _sinkMapper,
          onData,
          onError,
          onDone,
          cancelOnError ?? false,
        );
    return subscription;
  }
}
typedef void _TransformDataHandler<S, T>(S data, EventSink<T> sink);
typedef void _TransformErrorHandler<T>(
  Object error,
  StackTrace stackTrace,
  EventSink<T> sink,
);
typedef void _TransformDoneHandler<T>(EventSink<T> sink);
class _HandlerEventSink<S, T> implements EventSink<S> {
  final _TransformDataHandler<S, T>? _handleData;
  final _TransformErrorHandler<T>? _handleError;
  final _TransformDoneHandler<T>? _handleDone;
  EventSink<T>? _sink;
  _HandlerEventSink(
    this._handleData,
    this._handleError,
    this._handleDone,
    EventSink<T> this._sink,
  );
  void add(S data) {
    var sink = _sink;
    if (sink == null) {
      throw StateError("Sink is closed");
    }
    var handleData = _handleData;
    if (handleData != null) {
      handleData(data, sink);
    } else {
      sink.add(data as T);
    }
  }
  void addError(Object error, [StackTrace? stackTrace]) {
    var sink = _sink;
    if (sink == null) {
      throw StateError("Sink is closed");
    }
    var handleError = _handleError;
    stackTrace ??= AsyncError.defaultStackTrace(error);
    if (handleError != null) {
      handleError(error, stackTrace, sink);
    } else {
      sink.addError(error, stackTrace);
    }
  }
  void close() {
    var sink = _sink;
    if (sink == null) return;
    _sink = null;
    var handleDone = _handleDone;
    if (handleDone != null) {
      handleDone(sink);
    } else {
      sink.close();
    }
  }
}
class _StreamHandlerTransformer<S, T> extends _StreamSinkTransformer<S, T> {
  _StreamHandlerTransformer({
    void handleData(S data, EventSink<T> sink)?,
    void handleError(Object error, StackTrace stackTrace, EventSink<T> sink)?,
    void handleDone(EventSink<T> sink)?,
  }) : super((EventSink<T> outputSink) {
         return _HandlerEventSink<S, T>(
           handleData,
           handleError,
           handleDone,
           outputSink,
         );
       });
  Stream<T> bind(Stream<S> stream) {
    return super.bind(stream);
  }
}
class _StreamBindTransformer<S, T> extends StreamTransformerBase<S, T> {
  final Stream<T> Function(Stream<S>) _bind;
  _StreamBindTransformer(this._bind);
  Stream<T> bind(Stream<S> stream) => _bind(stream);
}
typedef StreamSubscription<T> _SubscriptionTransformer<S, T>(
  Stream<S> stream,
  bool cancelOnError,
);
class _StreamSubscriptionTransformer<S, T> extends StreamTransformerBase<S, T> {
  final _SubscriptionTransformer<S, T> _onListen;
  const _StreamSubscriptionTransformer(this._onListen);
  Stream<T> bind(Stream<S> stream) =>
      _BoundSubscriptionStream<S, T>(stream, _onListen);
}
class _BoundSubscriptionStream<S, T> extends Stream<T> {
  final _SubscriptionTransformer<S, T> _onListen;
  final Stream<S> _stream;
  bool get isBroadcast => _stream.isBroadcast;
  _BoundSubscriptionStream(this._stream, this._onListen);
  StreamSubscription<T> listen(
    void onData(T event)?, {
    Function? onError,
    void onDone()?,
    bool? cancelOnError,
  }) {
    StreamSubscription<T> result = _onListen(_stream, cancelOnError ?? false);
    result.onData(onData);
    result.onError(onError);
    result.onDone(onDone);
    return result;
  }
}

typedef void _TimerCallback();

abstract final class IterableElementError {
  static StateError noElement() => StateError("No element");
  static StateError tooMany() => StateError("Too many elements");
}

/** Records where an error was created, which the interpreter does not show. */
void _trySetStackTrace(Object error, StackTrace stackTrace) {}

void _runUnaryGuarded<T>(void Function(T) f, T arg) {
  try {
    f(arg);
  } catch (e, s) {
    _rootHandleError(e, s);
  }
}

void _runBinaryGuarded<T1, T2>(void Function(T1, T2) f, T1 arg1, T2 arg2) {
  try {
    f(arg1, arg2);
  } catch (e, s) {
    _rootHandleError(e, s);
  }
}

class CastStream<S, T> extends Stream<T> {
  final Stream<S> _source;
  CastStream(this._source);
  bool get isBroadcast => _source.isBroadcast;
  StreamSubscription<T> listen(
    void Function(T data)? onData, {
    Function? onError,
    void Function()? onDone,
    bool? cancelOnError,
  }) {
    return CastStreamSubscription<S, T>(
        _source.listen(null, onDone: onDone, cancelOnError: cancelOnError),
      )
      ..onData(onData)
      ..onError(onError);
  }
  Stream<R> cast<R>() => CastStream<S, R>(_source);
}
class CastStreamSubscription<S, T> implements StreamSubscription<T> {
  final StreamSubscription<S> _source;
  void Function(T)? _handleData;
  Function? _handleError;
  CastStreamSubscription(this._source) {
    _source.onData(_onData);
  }
  Future cancel() => _source.cancel();
  void onData(void Function(T data)? handleData) {
    _handleData = handleData == null
        ? null
        : handleData;
  }
  void onError(Function? handleError) {
    _source.onError(handleError);
    if (handleError == null) {
      _handleError = null;
    } else if (handleError is void Function(Object, StackTrace)) {
      _handleError = handleError;
    } else if (handleError is void Function(Object)) {
      _handleError = handleError;
    } else {
      throw ArgumentError(
        "handleError callback must take either an Object "
        "(the error), or both an Object (the error) and a StackTrace.",
      );
    }
  }
  void onDone(void handleDone()?) {
    _source.onDone(handleDone);
  }
  void _onData(S data) {
    if (_handleData == null) return;
    T targetData;
    try {
      targetData = data as T;
    } catch (error, stack) {
      var handleError = _handleError;
      if (handleError == null) {
        _rootHandleError(error, stack);
      } else if (handleError is void Function(Object, StackTrace)) {
        _runBinaryGuarded(handleError, error, stack);
      } else {
        _runUnaryGuarded(
          handleError as void Function(Object),
          error,
        );
      }
      return;
    }
    _runUnaryGuarded(_handleData!, targetData);
  }
  void pause([Future? resumeSignal]) {
    _source.pause(resumeSignal);
  }
  void resume() {
    _source.resume();
  }
  bool get isPaused => _source.isPaused;
  Future<E> asFuture<E>([E? futureValue]) => _source.asFuture<E>(futureValue);
}
class CastStreamTransformer<SS, ST, TS, TT>
    extends StreamTransformerBase<TS, TT> {
  final StreamTransformer<SS, ST> _source;
  CastStreamTransformer(this._source);
  StreamTransformer<RS, RT> cast<RS, RT>() =>
      CastStreamTransformer<SS, ST, RS, RT>(_source);
  Stream<TT> bind(Stream<TS> stream) =>
      _source.bind(stream.cast<SS>()).cast<TT>();
}
// The VM's _AsyncStarStreamController. Modification: a yield* of another async* body's fresh stream attaches that
// body to the root controller, the one the outermost body's listener listens to, instead of adding its stream through
// a subscription to it: the attached body adds its data and errors to the root directly, the root's pause, resume
// and cancel reach the innermost attached body as they would through the subscriptions, in their order, and only
// its end returns to the body that forwarded it; so a recursive yield* runs in a fixed depth of host frames.
class _AsyncStarStreamController<T> {
  StreamController<T> controller;
  void Function(Object?)? asyncStarBody;
  bool isAdding = false;
  bool onListenReceived = false;
  bool isScheduled = false;
  bool isSuspendedAtYield = false;
  _Future? cancellationFuture = null;
  /** The root controller this body adds to directly, once a yield* attached it, and the body that waits for it. */
  _AsyncStarStreamController? _root;
  _AsyncStarStreamController? _forwarder;
  /** The body this one forwards through a yield* that attached it. */
  _AsyncStarStreamController? _attached;
  /** Whether the root's cancel reached this attached body, whose end then returns to its forwarder through that. */
  bool _isCancelledByRoot = false;
  static final Expando<_AsyncStarStreamController> _streams = Expando<_AsyncStarStreamController>();
  late final Stream<T> stream = _registered(controller.stream);
  Stream<T> _registered(Stream<T> stream) {
    _streams[stream] = this;
    return stream;
  }
  /** The controller this body's events go to: the root's once attached. */
  StreamController get _out => _root?.controller ?? controller;
  void runBody() {
    isScheduled = false;
    isSuspendedAtYield = false;
    asyncStarBody!(!_out.hasListener);
  }
  void scheduleGenerator() {
    if (isScheduled || _out.isPaused || isAdding) {
      return;
    }
    isScheduled = true;
    scheduleMicrotask(runBody);
  }
  bool add(T event) {
    _out.add(event);
    if (!_out.hasListener) {
      return true;
    }
    scheduleGenerator();
    isSuspendedAtYield = true;
    return false;
  }
  bool addStream(Stream<T> stream) {
    if (!_out.hasListener) {
      return true;
    }
    isAdding = true;
    final body = _streams[stream];
    if (body != null && !body.onListenReceived && !body.controller.hasListener) {
      // The attached body starts as the subscription's listen would start it.
      body._root = _root ?? this;
      body._forwarder = this;
      _attached = body;
      body.onListen();
      return false;
    }
    final whenDoneAdding = controller.addStream(stream, cancelOnError: false);
    final self = this;
    whenDoneAdding.then((_) {
      self._attachedDone();
    });
    return false;
  }
  /** What the end of the stream this body forwards does: it continues after its yield*. */
  void _attachedDone() {
    _attached = null;
    isAdding = false;
    scheduleGenerator();
    if (!isScheduled) isSuspendedAtYield = true;
  }
  void addError(Object error, StackTrace stackTrace) {
    final future = cancellationFuture;
    if ((future != null) && future._mayComplete) {
      future._completeError(error, stackTrace);
      return;
    }
    if (!_out.hasListener) return;
    _out.addError(error, stackTrace);
  }
  close() {
    final future = cancellationFuture;
    if ((future != null) && future._mayComplete) {
      future._completeWithValue(null);
    }
    controller.close();
    final forwarder = _forwarder;
    // The done event of the stream it forwards completes its addStream future, whose listener the forwarder runs a
    // microtask later; after the root's cancel, the cancel's completion does that instead.
    if (forwarder != null && !_isCancelledByRoot) scheduleMicrotask(forwarder._attachedDone);
  }
  _AsyncStarStreamController() : controller = StreamController(sync: true) {
    controller.onListen = this.onListen;
    controller.onResume = this._onRootResume;
    controller.onCancel = this._onRootCancel;
  }
  onListen() {
    onListenReceived = true;
    scheduleGenerator();
  }
  onResume() {
    if (isSuspendedAtYield) {
      scheduleGenerator();
    }
  }
  /** The root's resume, which reaches each attached body in turn, as each subscription's resume would. */
  void _onRootResume() {
    for (_AsyncStarStreamController? body = this; body != null; body = body._attached) {
      body.onResume();
    }
  }
  /**
   * The root's cancel, which cancels the attached bodies innermost first, as the controller's addStream state cancels
   * its subscription before the controller's own onCancel runs.
   */
  _onRootCancel() {
    final attached = _attached;
    if (attached == null) return onCancel();
    attached._isCancelledByRoot = true;
    final cancel = attached._onRootCancel();
    final self = this;
    final Future result = cancel == null
        ? (() {
            scheduleMicrotask(self._attachedDone);
            return Future<void>.value();
          })()
        : (cancel as Future).whenComplete(() {
            scheduleMicrotask(self._attachedDone);
          });
    return result.whenComplete(() => self.onCancel());
  }
  onCancel() {
    if (controller.isClosed) {
      return null;
    }
    if (cancellationFuture == null) {
      cancellationFuture = _Future();
      if (isSuspendedAtYield) {
        scheduleGenerator();
      }
    }
    return cancellationFuture;
  }
}
`;
