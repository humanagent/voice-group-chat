"""Shared cancellation-safe and descriptor-relative filesystem operations.

These helpers keep cleanup and directory publication safe when the caller is
cancelled or when a filesystem does not support no-replace rename flags, and
provide atomic whole-file text/JSON writes for small persistent state.
"""

from __future__ import annotations

import asyncio
import ctypes
import errno
import fcntl
import json
import os
import secrets
import shutil
import tempfile
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import TypeVar, cast

RENAME_NOREPLACE = 1
RENAME_EXCL = 4
RENAME_UNSUPPORTED_ERRNOS = frozenset({errno.EINVAL, errno.ENOSYS, errno.ENOTSUP})
_T = TypeVar("_T")
DIRECTORY_OPEN_FLAGS = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
NOFOLLOW_OPEN_FLAGS = DIRECTORY_OPEN_FLAGS | getattr(os, "O_NOFOLLOW", 0)


async def await_cancellation_resistant(awaitable: Awaitable[_T]) -> _T:
    """Finish one cleanup operation before propagating caller cancellation."""
    task = asyncio.ensure_future(awaitable)
    caller = asyncio.current_task()
    caller_cancelled = False
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            if caller is not None and caller.cancelling():
                caller_cancelled = True
        except BaseException:
            break

    if caller_cancelled or (caller is not None and caller.cancelling()):
        if not task.cancelled():
            task.exception()
        raise asyncio.CancelledError()
    return task.result()


async def run_sync_cancellation_resistant(callback: Callable[[], _T]) -> _T:
    """Run blocking filesystem work off-loop and finish it before cancellation."""
    return await await_cancellation_resistant(asyncio.to_thread(callback))


async def remove_tree(path: str | Path) -> None:
    """Remove one private tree off-loop without abandoning it on cancellation."""
    await run_sync_cancellation_resistant(
        lambda: shutil.rmtree(path, ignore_errors=True)
    )


def fd_path(descriptor: int, relative: str = "") -> str:
    """Return a child-process path backed by one inherited directory fd."""
    if Path("/proc/self/fd").is_dir():
        path = f"/proc/self/fd/{descriptor}"
    else:
        path = os.fsdecode(
            fcntl.fcntl(descriptor, 50, b"\0" * 1_024).split(b"\0", 1)[0]
        )
    return f"{path}/{relative}" if relative else path


def remove_tree_at(parent_fd: int, name: str) -> None:
    """Remove one tree through its open parent without following symlinks."""

    def remove_entry(directory_fd: int, entry: str) -> None:
        try:
            child_fd = os.open(entry, NOFOLLOW_OPEN_FLAGS, dir_fd=directory_fd)
        except OSError as err:
            if err.errno not in {errno.ELOOP, errno.ENOTDIR}:
                if err.errno == errno.ENOENT:
                    return
                raise
            try:
                os.unlink(entry, dir_fd=directory_fd)
            except FileNotFoundError:
                return
            return

        try:
            for child in os.listdir(child_fd):
                remove_entry(child_fd, child)
        finally:
            os.close(child_fd)
        try:
            os.rmdir(entry, dir_fd=directory_fd)
        except FileNotFoundError:
            return

    remove_entry(parent_fd, name)


async def remove_tree_relative(parent_fd: int, name: str) -> None:
    """Remove a private tree through a stable parent descriptor."""
    await run_sync_cancellation_resistant(lambda: remove_tree_at(parent_fd, name))


def create_staging_directory_at(root_fd: int) -> str:
    """Create a private staging directory through the open Space root."""
    for _ in range(128):
        name = f".space-staging-{secrets.token_hex(12)}"
        try:
            os.mkdir(name, mode=0o700, dir_fd=root_fd)
        except FileExistsError:
            continue
        return name
    raise FileExistsError("could not allocate a private Space staging directory")


def rename_noreplace_at_syscall(parent_fd: int, source: str, target: str) -> int | None:
    """Run a no-replace rename relative to one stable parent descriptor."""
    libc = ctypes.CDLL(None, use_errno=True)
    try:
        renameat2 = libc.renameat2
    except AttributeError:
        try:
            renameatx = libc.renameatx_np
        except AttributeError:
            return None
        renameatx.argtypes = [
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_uint,
        ]
        renameatx.restype = ctypes.c_int
        result = cast(
            int,
            renameatx(
                parent_fd,
                os.fsencode(source),
                parent_fd,
                os.fsencode(target),
                RENAME_EXCL,
            ),
        )
    else:
        renameat2.argtypes = [
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_uint,
        ]
        renameat2.restype = ctypes.c_int
        result = cast(
            int,
            renameat2(
                parent_fd,
                os.fsencode(source),
                parent_fd,
                os.fsencode(target),
                RENAME_NOREPLACE,
            ),
        )
    return 0 if result == 0 else ctypes.get_errno()


def claim_by_locked_rename_at(parent_fd: int, source: str, target: str) -> None:
    """Serialize the portable fallback and publish one complete directory."""
    fcntl.flock(parent_fd, fcntl.LOCK_EX)
    try:
        try:
            os.stat(target, dir_fd=parent_fd, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise FileExistsError(
                errno.EEXIST, os.strerror(errno.EEXIST), target
            ) from None
        os.rename(source, target, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
    finally:
        fcntl.flock(parent_fd, fcntl.LOCK_UN)


def rename_noreplace_at(parent_fd: int, source: str, target: str) -> None:
    """Install a directory relative to a stable parent without replacement."""
    error_number = rename_noreplace_at_syscall(parent_fd, source, target)
    if error_number == 0:
        return
    if error_number is None or error_number in RENAME_UNSUPPORTED_ERRNOS:
        claim_by_locked_rename_at(parent_fd, source, target)
        return
    if error_number in {errno.EEXIST, errno.ENOTEMPTY}:
        raise FileExistsError(error_number, os.strerror(error_number), target)
    raise OSError(error_number, os.strerror(error_number), target)


def fsync_dir(path: Path) -> None:
    """Persist directory-entry changes."""
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_write_text(
    path: Path,
    text: str,
    *,
    fsync_dir: bool = False,
    tmp_prefix: str = ".atomic.",
) -> None:
    """Write text to a temporary file, then atomically replace the target."""
    path = Path(path)
    fd, tmp_path = tempfile.mkstemp(
        prefix=tmp_prefix,
        suffix=".tmp",
        dir=path.parent,
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            output.write(text)
            output.flush()
            os.fsync(output.fileno())
        os.replace(tmp_path, path)
        if fsync_dir:
            globals()["fsync_dir"](path.parent)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def atomic_write_json(
    path: Path,
    obj: object,
    *,
    fsync_dir: bool = False,
    tmp_prefix: str = ".atomic.",
) -> None:
    """Serialize an object and atomically write its JSON representation."""
    path = Path(path)
    fd, tmp_path = tempfile.mkstemp(
        prefix=tmp_prefix,
        suffix=".tmp",
        dir=path.parent,
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(obj, output, indent=2, ensure_ascii=False)
            output.flush()
            os.fsync(output.fileno())
        os.replace(tmp_path, path)
        if fsync_dir:
            globals()["fsync_dir"](path.parent)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise
