"""One place for the model, and one reader that gets it back."""

import pathlib
import tempfile

from src import defaults


def _home(text: str) -> pathlib.Path:
    home = pathlib.Path(tempfile.mkdtemp())
    (home / "config.yaml").write_text(text)
    return home


def test_what_is_written_is_what_is_read_back() -> None:
    """The round trip is the whole point: two scripts write these files and a
    third reads them, and they used to disagree."""
    home = _home(defaults.config_for(8700, headline="A group agent."))
    assert defaults.model_in(home) == defaults.DEFAULT_MODEL
    assert defaults.tts_model_in(home) == defaults.TTS_MODEL


def test_a_home_that_says_nothing_reads_as_nothing() -> None:
    """Not as the default. A missing config is a broken home, and reporting the
    default for it would hide that."""
    assert defaults.model_in(_home("plugins:\n  enabled:\n    - group-layer\n")) is None
    assert defaults.model_in(pathlib.Path("/nonexistent")) is None
    assert defaults.tts_model_in(pathlib.Path("/nonexistent")) is None


def test_the_model_is_read_as_a_block_not_as_the_first_default() -> None:
    """`platforms` and `tts` have their own keys. Hunting for a bare "default:"
    anywhere in the file let whichever came first win."""
    home = _home(
        "platforms:\n  api_server:\n    default: nonsense\n"
        "model:\n  default: openai/gpt-5.6-sol\n"
    )
    assert defaults.model_in(home) == "openai/gpt-5.6-sol"


def test_the_config_carries_what_the_gateway_needs() -> None:
    rendered = defaults.config_for(8642, headline="The single runtime.")
    for needed in ("model:", "group-layer", "api_server", "port: 8642", "tts:"):
        assert needed in rendered


def test_a_home_is_pointed_back_at_the_one_place(tmp_path: pathlib.Path) -> None:
    """Changing the model is changing one line. A home free to keep whatever it
    was created with is how that became editing four files and forgetting one."""
    (tmp_path / "config.yaml").write_text(
        defaults.config_for(8700, headline="x", model="some/other-model")
    )
    assert defaults.align(tmp_path) == f"some/other-model -> {defaults.DEFAULT_MODEL}"
    assert defaults.model_in(tmp_path) == defaults.DEFAULT_MODEL


def test_aligning_twice_changes_nothing_the_second_time(tmp_path: pathlib.Path) -> None:
    """It runs on every start, so it has to be silent when there is nothing to
    say — a line reporting a change that did not happen is noise on every boot."""
    (tmp_path / "config.yaml").write_text(
        defaults.config_for(8700, headline="x", model="some/other-model")
    )
    defaults.align(tmp_path)
    assert defaults.align(tmp_path) is None


def test_the_voice_model_is_pointed_back_too(tmp_path: pathlib.Path) -> None:
    """Both models live in the same file, so both follow it."""
    config = tmp_path / "config.yaml"
    config.write_text(
        defaults.config_for(8700, headline="x").replace(
            f"model_id: {defaults.TTS_MODEL}", "model_id: eleven_something_else"
        )
    )
    assert defaults.align(tmp_path) == f"eleven_something_else -> {defaults.TTS_MODEL}"
    assert defaults.tts_model_in(tmp_path) == defaults.TTS_MODEL


def test_a_home_that_was_never_provisioned_is_not_this_function_s_problem(
    tmp_path: pathlib.Path,
) -> None:
    """Provisioning writes the right thing the first time; there is nothing here
    to correct, and inventing a config for a directory would be a surprise."""
    assert defaults.align(tmp_path) is None
    assert not (tmp_path / "config.yaml").exists()
