from __future__ import annotations

import asyncio
import errno
import json
import os
import shutil
import threading
from pathlib import Path

import pytest

from src.lib import atomic_fs
from src.lib.atomic_fs import atomic_write_json


def test_no_replace_rename_rejects_an_empty_existing_target(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    (source / "ours").write_text("ours\n")
    target = tmp_path / "target"
    target.mkdir()
    root_fd = os.open(tmp_path, os.O_RDONLY)
    try:
        with pytest.raises(FileExistsError):
            atomic_fs.rename_noreplace_at(root_fd, source.name, target.name)
    finally:
        os.close(root_fd)

    assert list(target.iterdir()) == []
    assert (source / "ours").read_text() == "ours\n"


def test_unsupported_rename_falls_back_to_complete_publication(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        atomic_fs,
        "rename_noreplace_at_syscall",
        lambda parent_fd, source, target: errno.EINVAL,
    )
    source = tmp_path / "source"
    (source / "nested").mkdir(parents=True)
    (source / "nested" / "file").write_text("payload\n")
    root_fd = os.open(tmp_path, os.O_RDONLY)
    try:
        atomic_fs.rename_noreplace_at(root_fd, source.name, "target")
    finally:
        os.close(root_fd)

    assert (tmp_path / "target" / "nested" / "file").read_text() == "payload\n"


def test_remove_tree_finishes_before_cancellation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    tree = tmp_path / "tree"
    tree.mkdir()
    (tree / "file").write_text("data")
    cleanup_started = threading.Event()
    release_cleanup = threading.Event()
    real_rmtree = shutil.rmtree

    def _blocking_rmtree(*_args: object, **_kwargs: object) -> None:
        cleanup_started.set()
        release_cleanup.wait()
        real_rmtree(tree)

    monkeypatch.setattr(atomic_fs.shutil, "rmtree", _blocking_rmtree)

    async def scenario() -> None:
        task = asyncio.create_task(atomic_fs.remove_tree(tree))
        started = await asyncio.wait_for(
            asyncio.to_thread(cleanup_started.wait, 1), timeout=2
        )
        assert started is True
        task.cancel()
        await asyncio.sleep(0)
        assert task.done() is False
        release_cleanup.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert not tree.exists()

    try:
        asyncio.run(scenario())
    finally:
        release_cleanup.set()


def test_atomic_write_json_preserves_previous_file_when_serialization_fails(tmp_path):
    path = tmp_path / "state.json"
    path.write_text('{"old": true}', encoding="utf-8")

    class Unserializable:
        pass

    with pytest.raises(TypeError):
        atomic_write_json(path, {"new": Unserializable()})

    assert path.read_text(encoding="utf-8") == '{"old": true}'
    assert tuple(tmp_path.glob("*.tmp")) == ()


def test_atomic_write_json_can_fsync_directory(tmp_path, monkeypatch):
    path = tmp_path / "state.json"
    synced: list[Path] = []
    monkeypatch.setattr(atomic_fs, "fsync_dir", synced.append)

    atomic_write_json(path, {"answer": 42}, fsync_dir=True)

    assert json.loads(path.read_text(encoding="utf-8")) == {"answer": 42}
    assert synced == [path.parent]
