"""Linux amd64 worker network boundary, inherited across exec by soffice."""
import ctypes
import errno
import platform
import socket


def deny_ip_network():
    if platform.system() != "Linux" or platform.machine() != "x86_64":
        raise RuntimeError("Unsupported sandbox platform")

    class Filter(ctypes.Structure):
        _fields_ = [("code", ctypes.c_ushort), ("jt", ctypes.c_ubyte), ("jf", ctypes.c_ubyte), ("k", ctypes.c_uint)]

    class Program(ctypes.Structure):
        _fields_ = [("len", ctypes.c_ushort), ("filter", ctypes.POINTER(Filter))]

    # seccomp_data arch@4, nr@0, args[0]@16. Only AF_UNIX sockets allowed;
    # existing fds are pipes and files (Popen close_fds), never service sockets.
    instructions = [
        (0x20, 0, 0, 4), (0x15, 1, 0, 0xC000003E), (0x06, 0, 0, 0x80000000),
        (0x20, 0, 0, 0), (0x35, 0, 1, 0x40000000), (0x06, 0, 0, 0x80000000),
        # io_uring can create sockets without the socket syscall. Deny the API,
        # independently of the enclosing container's default seccomp policy.
        (0x15, 0, 1, 425), (0x06, 0, 0, 0x00050000 | errno.EPERM),
        (0x15, 0, 1, 426), (0x06, 0, 0, 0x00050000 | errno.EPERM),
        (0x15, 0, 1, 427), (0x06, 0, 0, 0x00050000 | errno.EPERM),
        (0x15, 1, 0, 41), (0x15, 0, 3, 53),
        (0x20, 0, 0, 16), (0x15, 1, 0, socket.AF_UNIX),
        (0x06, 0, 0, 0x00050000 | errno.EPERM), (0x06, 0, 0, 0x7FFF0000),
    ]
    filters = (Filter * len(instructions))(*(Filter(*item) for item in instructions))
    program = Program(len(filters), filters)
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(38, 1, 0, 0, 0) or libc.prctl(22, 2, ctypes.byref(program), 0, 0):
        raise RuntimeError("Network sandbox unavailable")
    # Fail closed before any untrusted document is loaded.
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    except PermissionError:
        return
    else:
        probe.close()
        raise RuntimeError("Network sandbox ineffective")
