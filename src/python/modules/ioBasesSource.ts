// The IOBase, RawIOBase, BufferedIOBase, BufferedReader, and BufferedWriter classes of CPython 3.14's `Lib/_pyio.py`,
// which the compression modules build their streams on, as classes of their own apart from the io module's.
export const IO_BASES_SOURCE =
  String.raw`import abc
import errno
import sys
from _thread import allocate_lock as Lock
from io import UnsupportedOperation, SEEK_SET, SEEK_CUR, SEEK_END

valid_seek_flags = {0, 1, 2}
DEFAULT_BUFFER_SIZE = 128 * 1024


class IOBase(metaclass=abc.ABCMeta):

    """The abstract base class for all I/O classes.

    This class provides dummy implementations for many methods that
    derived classes can override selectively; the default implementations
    represent a file that cannot be read, written or seeked.

    Even though IOBase does not declare read or write because
    their signatures will vary, implementations and clients should
    consider those methods part of the interface. Also, implementations
    may raise UnsupportedOperation when operations they do not support are
    called.

    The basic type used for binary data read from or written to a file is
    bytes. Other bytes-like objects are accepted as method arguments too.
    Text I/O classes work with str data.

    Note that calling any method (even inquiries) on a closed stream is
    undefined. Implementations may raise OSError in this case.

    IOBase (and its subclasses) support the iterator protocol, meaning
    that an IOBase object can be iterated over yielding the lines in a
    stream.

    IOBase also supports the :keyword:` +
  '`' +
  String.raw`with` +
  '`' +
  String.raw` statement. In this example,
    fp is closed after the suite of the with statement is complete:

    with open('spam.txt', 'r') as fp:
        fp.write('Spam and eggs!')
    """

    ### Internal ###

    def _unsupported(self, name):
        """Internal: raise an OSError exception for unsupported operations."""
        raise UnsupportedOperation("%s.%s() not supported" %
                                   (self.__class__.__name__, name))

    ### Positioning ###

    def seek(self, pos, whence=0):
        """Change stream position.

        Change the stream position to byte offset pos. Argument pos is
        interpreted relative to the position indicated by whence.  Values
        for whence are ints:

        * 0 -- start of stream (the default); offset should be zero or
          positive
        * 1 -- current stream position; offset may be negative
        * 2 -- end of stream; offset is usually negative
        Some operating systems / file systems could provide additional
        values.

        Return an int indicating the new absolute position.
        """
        self._unsupported("seek")

    def tell(self):
        """Return an int indicating the current stream position."""
        return self.seek(0, 1)

    def truncate(self, pos=None):
        """Truncate file to size bytes.

        Size defaults to the current IO position as reported by tell().
        Return the new size.
        """
        self._unsupported("truncate")

    ### Flush and close ###

    def flush(self):
        """Flush write buffers, if applicable.

        This is not implemented for read-only and non-blocking streams.
        """
        self._checkClosed()
        # XXX Should this return the number of bytes written???

    __closed = False

    def close(self):
        """Flush and close the IO object.

        This method has no effect if the file is already closed.
        """
        if not self.__closed:
            try:
                self.flush()
            finally:
                self.__closed = True

    def __del__(self):
        """Destructor.  Calls close()."""
        try:
            closed = self.closed
        except AttributeError:
            # If getting closed fails, then the object is probably
            # in an unusable state, so ignore.
            return

        if closed:
            return

        if dealloc_warn := getattr(self, "_dealloc_warn", None):
            dealloc_warn(self)

        # If close() fails, the caller logs the exception with
        # sys.unraisablehook. close() must be called at the end at __del__().
        self.close()

    ### Inquiries ###

    def seekable(self):
        """Return a bool indicating whether object supports random access.

        If False, seek(), tell() and truncate() will raise OSError.
        This method may need to do a test seek().
        """
        return False

    def _checkSeekable(self, msg=None):
        """Internal: raise UnsupportedOperation if file is not seekable
        """
        if not self.seekable():
            raise UnsupportedOperation("File or stream is not seekable."
                                       if msg is None else msg)

    def readable(self):
        """Return a bool indicating whether object was opened for reading.

        If False, read() will raise OSError.
        """
        return False

    def _checkReadable(self, msg=None):
        """Internal: raise UnsupportedOperation if file is not readable
        """
        if not self.readable():
            raise UnsupportedOperation("File or stream is not readable."
                                       if msg is None else msg)

    def writable(self):
        """Return a bool indicating whether object was opened for writing.

        If False, write() and truncate() will raise OSError.
        """
        return False

    def _checkWritable(self, msg=None):
        """Internal: raise UnsupportedOperation if file is not writable
        """
        if not self.writable():
            raise UnsupportedOperation("File or stream is not writable."
                                       if msg is None else msg)

    @property
    def closed(self):
        """closed: bool.  True iff the file has been closed.

        For backwards compatibility, this is a property, not a predicate.
        """
        return self.__closed

    def _checkClosed(self, msg=None):
        """Internal: raise a ValueError if file is closed
        """
        if self.closed:
            raise ValueError("I/O operation on closed file."
                             if msg is None else msg)

    ### Context manager ###

    def __enter__(self):  # That's a forward reference
        """Context management protocol.  Returns self (an instance of IOBase)."""
        self._checkClosed()
        return self

    def __exit__(self, *args):
        """Context management protocol.  Calls close()"""
        self.close()

    ### Lower-level APIs ###

    # XXX Should these be present even if unimplemented?

    def fileno(self):
        """Returns underlying file descriptor (an int) if one exists.

        An OSError is raised if the IO object does not use a file
        descriptor.
        """
        self._unsupported("fileno")

    def isatty(self):
        """Return a bool indicating whether this is an 'interactive' stream.

        Return False if it can't be determined.
        """
        self._checkClosed()
        return False

    ### Readline[s] and writelines ###

    def readline(self, size=-1):
        r"""Read and return a line of bytes from the stream.

        If size is specified, at most size bytes will be read.
        Size should be an int.

        The line terminator is always b'\n' for binary files; for text
        files, the newlines argument to open can be used to select the line
        terminator(s) recognized.
        """
        # For backwards compatibility, a (slowish) readline().
        if hasattr(self, "peek"):
            def nreadahead():
                readahead = self.peek(1)
                if not readahead:
                    return 1
                n = (readahead.find(b"\n") + 1) or len(readahead)
                if size >= 0:
                    n = min(n, size - len(res))
                return n
        else:
            def nreadahead():
                return 1
        if size is None:
            size = -1
        else:
            try:
                size_index = size.__index__
            except AttributeError:
                raise TypeError(f"{size!r} is not an integer")
            else:
                size = size_index()
        res = bytearray()
        while size < 0 or len(res) < size:
            b = self.read(nreadahead())
            if not b:
                break
            res += b
            if res.endswith(b"\n"):
                break
        return bytes(res)

    def __iter__(self):
        self._checkClosed()
        return self

    def __next__(self):
        line = self.readline()
        if not line:
            raise StopIteration
        return line

    def readlines(self, hint=None):
        """Return a list of lines from the stream.

        hint can be specified to control the number of lines read: no more
        lines will be read if the total size (in bytes/characters) of all
        lines so far exceeds hint.
        """
        if hint is None or hint <= 0:
            return list(self)
        n = 0
        lines = []
        for line in self:
            lines.append(line)
            n += len(line)
            if n >= hint:
                break
        return lines

    def writelines(self, lines):
        """Write a list of lines to the stream.

        Line separators are not added, so it is usual for each of the lines
        provided to have a line separator at the end.
        """
        self._checkClosed()
        for line in lines:
            self.write(line)



class RawIOBase(IOBase):

    """Base class for raw binary I/O."""

    # The read() method is implemented by calling readinto(); derived
    # classes that want to support read() only need to implement
    # readinto() as a primitive operation.  In general, readinto() can be
    # more efficient than read().

    # (It would be tempting to also provide an implementation of
    # readinto() in terms of read(), in case the latter is a more suitable
    # primitive operation, but that would lead to nasty recursion in case
    # a subclass doesn't implement either.)

    def read(self, size=-1):
        """Read and return up to size bytes, where size is an int.

        Returns an empty bytes object on EOF, or None if the object is
        set not to block and has no data to read.
        """
        if size is None:
            size = -1
        if size < 0:
            return self.readall()
        b = bytearray(size.__index__())
        n = self.readinto(b)
        if n is None:
            return None
        if n < 0 or n > len(b):
            raise ValueError(f"readinto returned {n} outside buffer size {len(b)}")
        del b[n:]
        return bytes(b)

    def readall(self):
        """Read until EOF, using multiple read() call."""
        res = bytearray()
        while data := self.read(DEFAULT_BUFFER_SIZE):
            res += data
        if res:
            return bytes(res)
        else:
            # b'' or None
            return data

    def readinto(self, b):
        """Read bytes into a pre-allocated bytes-like object b.

        Returns an int representing the number of bytes read (0 for EOF), or
        None if the object is set not to block and has no data to read.
        """
        self._unsupported("readinto")

    def write(self, b):
        """Write the given buffer to the IO stream.

        Returns the number of bytes written, which may be less than the
        length of b in bytes.
        """
        self._unsupported("write")



class BufferedIOBase(IOBase):

    """Base class for buffered IO objects.

    The main difference with RawIOBase is that the read() method
    supports omitting the size argument, and does not have a default
    implementation that defers to readinto().

    In addition, read(), readinto() and write() may raise
    BlockingIOError if the underlying raw stream is in non-blocking
    mode and not ready; unlike their raw counterparts, they will never
    return None.

    A typical implementation should not inherit from a RawIOBase
    implementation, but wrap one.
    """

    def read(self, size=-1):
        """Read and return up to size bytes, where size is an int.

        If the argument is omitted, None, or negative, reads and
        returns all data until EOF.

        If the argument is positive, and the underlying raw stream is
        not 'interactive', multiple raw reads may be issued to satisfy
        the byte count (unless EOF is reached first).  But for
        interactive raw streams (XXX and for pipes?), at most one raw
        read will be issued, and a short result does not imply that
        EOF is imminent.

        Returns an empty bytes array on EOF.

        Raises BlockingIOError if the underlying raw stream has no
        data at the moment.
        """
        self._unsupported("read")

    def read1(self, size=-1):
        """Read up to size bytes with at most one read() system call,
        where size is an int.
        """
        self._unsupported("read1")

    def readinto(self, b):
        """Read bytes into a pre-allocated bytes-like object b.

        Like read(), this may issue multiple reads to the underlying raw
        stream, unless the latter is 'interactive'.

        Returns an int representing the number of bytes read (0 for EOF).

        Raises BlockingIOError if the underlying raw stream has no
        data at the moment.
        """

        return self._readinto(b, read1=False)

    def readinto1(self, b):
        """Read bytes into buffer *b*, using at most one system call

        Returns an int representing the number of bytes read (0 for EOF).

        Raises BlockingIOError if the underlying raw stream has no
        data at the moment.
        """

        return self._readinto(b, read1=True)

    def _readinto(self, b, read1):
        if not isinstance(b, memoryview):
            b = memoryview(b)
        b = b.cast('B')

        if read1:
            data = self.read1(len(b))
        else:
            data = self.read(len(b))
        n = len(data)

        b[:n] = data

        return n

    def write(self, b):
        """Write the given bytes buffer to the IO stream.

        Return the number of bytes written, which is always the length of b
        in bytes.

        Raises BlockingIOError if the buffer is full and the
        underlying raw stream cannot accept more data at the moment.
        """
        self._unsupported("write")

    def detach(self):
        """
        Separate the underlying raw stream from the buffer and return it.

        After the raw stream has been detached, the buffer is in an unusable
        state.
        """
        self._unsupported("detach")



class _BufferedIOMixin(BufferedIOBase):

    """A mixin implementation of BufferedIOBase with an underlying raw stream.

    This passes most requests on to the underlying raw stream.  It
    does *not* provide implementations of read(), readinto() or
    write().
    """

    def __init__(self, raw):
        self._raw = raw

    ### Positioning ###

    def seek(self, pos, whence=0):
        new_position = self.raw.seek(pos, whence)
        if new_position < 0:
            raise OSError("seek() returned an invalid position")
        return new_position

    def tell(self):
        pos = self.raw.tell()
        if pos < 0:
            raise OSError("tell() returned an invalid position")
        return pos

    def truncate(self, pos=None):
        self._checkClosed()
        self._checkWritable()

        # Flush the stream.  We're mixing buffered I/O with lower-level I/O,
        # and a flush may be necessary to synch both views of the current
        # file state.
        self.flush()

        if pos is None:
            pos = self.tell()
        # XXX: Should seek() be used, instead of passing the position
        # XXX  directly to truncate?
        return self.raw.truncate(pos)

    ### Flush and close ###

    def flush(self):
        if self.closed:
            raise ValueError("flush on closed file")
        self.raw.flush()

    def close(self):
        if self.raw is not None and not self.closed:
            try:
                # may raise BlockingIOError or BrokenPipeError etc
                self.flush()
            finally:
                self.raw.close()

    def detach(self):
        if self.raw is None:
            raise ValueError("raw stream already detached")
        self.flush()
        raw = self._raw
        self._raw = None
        return raw

    ### Inquiries ###

    def seekable(self):
        return self.raw.seekable()

    @property
    def raw(self):
        return self._raw

    @property
    def closed(self):
        return self.raw.closed

    @property
    def name(self):
        return self.raw.name

    @property
    def mode(self):
        return self.raw.mode

    def __getstate__(self):
        raise TypeError(f"cannot pickle {self.__class__.__name__!r} object")

    def __repr__(self):
        modname = self.__class__.__module__
        clsname = self.__class__.__qualname__
        try:
            name = self.name
        except AttributeError:
            return "<{}.{}>".format(modname, clsname)
        else:
            return "<{}.{} name={!r}>".format(modname, clsname, name)

    def _dealloc_warn(self, source):
        if dealloc_warn := getattr(self.raw, "_dealloc_warn", None):
            dealloc_warn(source)

    ### Lower-level APIs ###

    def fileno(self):
        return self.raw.fileno()

    def isatty(self):
        return self.raw.isatty()


class BufferedReader(_BufferedIOMixin):

    """BufferedReader(raw[, buffer_size])

    A buffer for a readable, sequential BaseRawIO object.

    The constructor creates a BufferedReader for the given readable raw
    stream and buffer_size. If buffer_size is omitted, DEFAULT_BUFFER_SIZE
    is used.
    """

    def __init__(self, raw, buffer_size=DEFAULT_BUFFER_SIZE):
        """Create a new buffered reader using the given readable raw IO object.
        """
        if not raw.readable():
            raise OSError('"raw" argument must be readable.')

        _BufferedIOMixin.__init__(self, raw)
        if buffer_size <= 0:
            raise ValueError("invalid buffer size")
        self.buffer_size = buffer_size
        self._reset_read_buf()
        self._read_lock = Lock()

    def readable(self):
        return self.raw.readable()

    def _reset_read_buf(self):
        self._read_buf = b""
        self._read_pos = 0

    def read(self, size=None):
        """Read size bytes.

        Returns exactly size bytes of data unless the underlying raw IO
        stream reaches EOF or if the call would block in non-blocking
        mode. If size is negative, read until EOF or until read() would
        block.
        """
        if size is not None and size < -1:
            raise ValueError("invalid number of bytes to read")
        with self._read_lock:
            return self._read_unlocked(size)

    def _read_unlocked(self, n=None):
        nodata_val = b""
        empty_values = (b"", None)
        buf = self._read_buf
        pos = self._read_pos

        # Special case for when the number of bytes to read is unspecified.
        if n is None or n == -1:
            self._reset_read_buf()
            if hasattr(self.raw, 'readall'):
                chunk = self.raw.readall()
                if chunk is None:
                    return buf[pos:] or None
                else:
                    return buf[pos:] + chunk
            chunks = [buf[pos:]]  # Strip the consumed bytes.
            current_size = 0
            while True:
                # Read until EOF or until read() would block.
                chunk = self.raw.read()
                if chunk in empty_values:
                    nodata_val = chunk
                    break
                current_size += len(chunk)
                chunks.append(chunk)
            return b"".join(chunks) or nodata_val

        # The number of bytes to read is specified, return at most n bytes.
        avail = len(buf) - pos  # Length of the available buffered data.
        if n <= avail:
            # Fast path: the data to read is fully buffered.
            self._read_pos += n
            return buf[pos:pos+n]
        # Slow path: read from the stream until enough bytes are read,
        # or until an EOF occurs or until read() would block.
        chunks = [buf[pos:]]
        wanted = max(self.buffer_size, n)
        while avail < n:
            chunk = self.raw.read(wanted)
            if chunk in empty_values:
                nodata_val = chunk
                break
            avail += len(chunk)
            chunks.append(chunk)
        # n is more than avail only when an EOF occurred or when
        # read() would have blocked.
        n = min(n, avail)
        out = b"".join(chunks)
        self._read_buf = out[n:]  # Save the extra data in the buffer.
        self._read_pos = 0
        return out[:n] if out else nodata_val

    def peek(self, size=0):
        """Returns buffered bytes without advancing the position.

        The argument indicates a desired minimal number of bytes; we
        do at most one raw read to satisfy it.  We never return more
        than self.buffer_size.
        """
        self._checkClosed("peek of closed file")
        with self._read_lock:
            return self._peek_unlocked(size)

    def _peek_unlocked(self, n=0):
        want = min(n, self.buffer_size)
        have = len(self._read_buf) - self._read_pos
        if have < want or have <= 0:
            to_read = self.buffer_size - have
            current = self.raw.read(to_read)
            if current:
                self._read_buf = self._read_buf[self._read_pos:] + current
                self._read_pos = 0
        return self._read_buf[self._read_pos:]

    def read1(self, size=-1):
        """Reads up to size bytes, with at most one read() system call."""
        # Returns up to size bytes.  If at least one byte is buffered, we
        # only return buffered bytes.  Otherwise, we do one raw read.
        self._checkClosed("read of closed file")
        if size < 0:
            size = self.buffer_size
        if size == 0:
            return b""
        with self._read_lock:
            self._peek_unlocked(1)
            return self._read_unlocked(
                min(size, len(self._read_buf) - self._read_pos))

    # Implementing readinto() and readinto1() is not strictly necessary (we
    # could rely on the base class that provides an implementation in terms of
    # read() and read1()). We do it anyway to keep the _pyio implementation
    # similar to the io implementation (which implements the methods for
    # performance reasons).
    def _readinto(self, buf, read1):
        """Read data into *buf* with at most one system call."""

        self._checkClosed("readinto of closed file")

        # Need to create a memoryview object of type 'b', otherwise
        # we may not be able to assign bytes to it, and slicing it
        # would create a new object.
        if not isinstance(buf, memoryview):
            buf = memoryview(buf)
        if buf.nbytes == 0:
            return 0
        buf = buf.cast('B')

        written = 0
        with self._read_lock:
            while written < len(buf):

                # First try to read from internal buffer
                avail = min(len(self._read_buf) - self._read_pos, len(buf))
                if avail:
                    buf[written:written+avail] = \
                        self._read_buf[self._read_pos:self._read_pos+avail]
                    self._read_pos += avail
                    written += avail
                    if written == len(buf):
                        break

                # If remaining space in callers buffer is larger than
                # internal buffer, read directly into callers buffer
                if len(buf) - written > self.buffer_size:
                    n = self.raw.readinto(buf[written:])
                    if not n:
                        break # eof
                    written += n

                # Otherwise refill internal buffer - unless we're
                # in read1 mode and already got some data
                elif not (read1 and written):
                    if not self._peek_unlocked(1):
                        break # eof

                # In readinto1 mode, return as soon as we have some data
                if read1 and written:
                    break

        return written

    def tell(self):
        # GH-95782: Keep return value non-negative
        return max(_BufferedIOMixin.tell(self) - len(self._read_buf) + self._read_pos, 0)

    def seek(self, pos, whence=0):
        if whence not in valid_seek_flags:
            raise ValueError("invalid whence value")
        self._checkClosed("seek of closed file")
        with self._read_lock:
            if whence == 1:
                pos -= len(self._read_buf) - self._read_pos
            pos = _BufferedIOMixin.seek(self, pos, whence)
            self._reset_read_buf()
            return pos

class BufferedWriter(_BufferedIOMixin):

    """A buffer for a writeable sequential RawIO object.

    The constructor creates a BufferedWriter for the given writeable raw
    stream. If the buffer_size is not given, it defaults to
    DEFAULT_BUFFER_SIZE.
    """

    def __init__(self, raw, buffer_size=DEFAULT_BUFFER_SIZE):
        if not raw.writable():
            raise OSError('"raw" argument must be writable.')

        _BufferedIOMixin.__init__(self, raw)
        if buffer_size <= 0:
            raise ValueError("invalid buffer size")
        self.buffer_size = buffer_size
        self._write_buf = bytearray()
        self._write_lock = Lock()

    def writable(self):
        return self.raw.writable()

    def write(self, b):
        if isinstance(b, str):
            raise TypeError("can't write str to binary stream")
        with self._write_lock:
            if self.closed:
                raise ValueError("write to closed file")
            # XXX we can implement some more tricks to try and avoid
            # partial writes
            if len(self._write_buf) > self.buffer_size:
                # We're full, so let's pre-flush the buffer.  (This may
                # raise BlockingIOError with characters_written == 0.)
                self._flush_unlocked()
            before = len(self._write_buf)
            self._write_buf.extend(b)
            written = len(self._write_buf) - before
            if len(self._write_buf) > self.buffer_size:
                try:
                    self._flush_unlocked()
                except BlockingIOError as e:
                    if len(self._write_buf) > self.buffer_size:
                        # We've hit the buffer_size. We have to accept a partial
                        # write and cut back our buffer.
                        overage = len(self._write_buf) - self.buffer_size
                        written -= overage
                        self._write_buf = self._write_buf[:self.buffer_size]
                        raise BlockingIOError(e.errno, e.strerror, written)
            return written

    def truncate(self, pos=None):
        with self._write_lock:
            self._flush_unlocked()
            if pos is None:
                pos = self.raw.tell()
            return self.raw.truncate(pos)

    def flush(self):
        with self._write_lock:
            self._flush_unlocked()

    def _flush_unlocked(self):
        if self.closed:
            raise ValueError("flush on closed file")
        while self._write_buf:
            try:
                n = self.raw.write(self._write_buf)
            except BlockingIOError:
                raise RuntimeError("self.raw should implement RawIOBase: it "
                                   "should not raise BlockingIOError")
            if n is None:
                raise BlockingIOError(
                    errno.EAGAIN,
                    "write could not complete without blocking", 0)
            if n > len(self._write_buf) or n < 0:
                raise OSError("write() returned incorrect number of bytes")
            del self._write_buf[:n]

    def tell(self):
        return _BufferedIOMixin.tell(self) + len(self._write_buf)

    def seek(self, pos, whence=0):
        if whence not in valid_seek_flags:
            raise ValueError("invalid whence value")
        with self._write_lock:
            self._flush_unlocked()
            return _BufferedIOMixin.seek(self, pos, whence)

    def close(self):
        with self._write_lock:
            if self.raw is None or self.closed:
                return
        # We have to release the lock and call self.flush() (which will
        # probably just re-take the lock) in case flush has been overridden in
        # a subclass or the user set self.flush to something. This is the same
        # behavior as the C implementation.
        try:
            # may raise BlockingIOError or BrokenPipeError etc
            self.flush()
        finally:
            with self._write_lock:
                self.raw.close()


`;
