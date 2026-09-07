#!/usr/bin/env python3
"""A group chat with several agents in it.

    scripts/group_up.py Anna Jordan Pepe       # once
    scripts/group.py                          # then talk, in a new group
    scripts/group.py --session group-1787…    # or reopen one

Inside it, `/mode speak | mention | paused` settles how much the room talks.
That switch belongs to the group, so it lives in the group — it is written into
every agent's home at once.

Every line goes to every agent, and what an agent says becomes a line the others
read. Nobody is told whose turn it is: each one decides for itself, from the
same transcript, and the ones it was not for stay quiet.

That is the whole demonstration. One agent told to answer everything is fine.
Three of them is a room nobody can use — so the interesting output here is not
what gets said, it is how much does not.
"""

from __future__ import annotations

import pathlib
import queue
import shutil
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from src.group import (  # noqa: E402
    ROOM,
    Agent,
    Line,
    briefing,
    cast,
    deliver,
    holds,
    load_agents,
    open_chat,
    roster,
)
from src.policy import participation, voice  # noqa: E402

REPO = pathlib.Path(__file__).resolve().parents[1]
DIM, BOLD, BAD, OFF = "\033[2m", "\033[1m", "\033[38;5;131m", "\033[0m"
VOICES = ["\033[38;5;173m", "\033[38;5;108m", "\033[38;5;110m", "\033[38;5;180m"]



# Clips are played one at a time, on one thread, in the order they were queued.
# Three replies overlapping is noise — in a group, who spoke after whom is most
# of the meaning — but WAITING for each clip is not how you get that order, it
# is just how you add its length to the round. Playing on the side keeps the
# sequence and gives the text back immediately.
_AUDIO: queue.Queue = queue.Queue()
_PLAYER: threading.Thread | None = None


def _play_queued() -> None:
    while True:
        path = _AUDIO.get()
        player = shutil.which("afplay") or shutil.which("mpv") or shutil.which("ffplay")
        if not player:
            continue
        args = [player, path]
        if player.endswith("ffplay"):
            args = [player, "-nodisp", "-autoexit", "-loglevel", "quiet", path]
        try:
            subprocess.run(
                args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60
            )
        except Exception:  # noqa: BLE001
            pass


def play(path: str) -> None:
    """Queue one clip. Returns immediately; the queue keeps the order."""
    global _PLAYER
    if _PLAYER is None:
        _PLAYER = threading.Thread(target=_play_queued, daemon=True)
        _PLAYER.start()
    _AUDIO.put(path)


def mode_of(agents: list[Agent], chat: str) -> str:
    """The group's mode, read from the agents themselves.

    Each one is its own gateway with its own home, so the mode is stored three
    times. They should agree; when they do not, say so rather than pick one —
    a group where two agents are paused and one is not is exactly the state
    worth seeing.
    """
    seen = {participation.mode(chat, a.home(REPO)) for a in agents}
    return seen.pop() if len(seen) == 1 else "split: " + ", ".join(sorted(seen))


def set_mode(agents: list[Agent], chat: str, text: str) -> None:
    """`/mode` — the group's participation switch, from inside the group.

    It lives here rather than in the launcher's menu because it belongs to this
    conversation: the moment you want the room to go quiet is while you are in
    it, not two screens away in a chat picker.

    Written into every agent's home, because that is where each gateway reads
    it. One file in the launcher's home would be read by nobody, and the switch
    would look like it worked while changing nothing.
    """
    arg = text.split(maxsplit=1)[1].strip() if len(text.split(maxsplit=1)) > 1 else ""
    if not arg:
        print(f"{DIM}  {chat} is '{mode_of(agents, chat)}'"
              f" — /mode {' | '.join(participation.MODES)}{OFF}\n")
        return
    want = participation.resolve(arg)
    if not want:
        print(f"{DIM}  no mode {arg!r} — {', '.join(participation.MODES)}{OFF}\n")
        return
    for agent in agents:
        participation.set_mode(chat, want, agent.home(REPO))
    print(f"{DIM}  {chat} → {want} · all {len(agents)} agents{OFF}\n")


def colour(agents: list[Agent], name: str) -> str:
    names = [a.name for a in agents]
    return VOICES[names.index(name) % len(VOICES)] if name in names else BOLD


def audience_for(agents: list[Agent], line: Line) -> list[Agent]:
    """Who hears this line: everyone but whoever said it.

    Every line reaches every agent, whether a person or an agent said it. That
    is what makes it a room, and each of them deciding for itself whether it was
    meant is the whole demonstration.

    It was briefly narrower — a reply went only to the agents it named, which is
    faster and cheaper and quietly wrong. Pepe, asked to pass the standup on,
    handed it back to Anna: he had never been given her turn, so he did not know
    she had gone. Not a lapse in judgement, a hole in what he was told. An agent
    cannot decide well about a conversation it is only hearing half of.

    An agent never receives its own line: it has just spoken, and a transcript
    that reads its own words back to it is how a model starts talking to itself.
    """
    return [a for a in agents if a.name != line.speaker]


def round_of(
    agents: list[Agent],
    chat: str,
    line: Line,
    *,
    quiet: set[str],
    failed: list[str],
) -> list[Line]:
    """Hand one line to every agent at once, and collect what came back.

    In parallel because they are independent: three sequential turns would make
    a group three times slower than one agent for no reason, and the last agent
    would be answering a room that had already moved on.

    Who is in the audience is `audience_for`'s decision.
    """
    audience = audience_for(agents, line)
    if not audience:
        return []

    out: list[Line] = []
    with ThreadPoolExecutor(max_workers=len(audience)) as pool:
        pending = {
            pool.submit(deliver, agent, chat, line): agent for agent in audience
        }
        # As each one lands, not once they all have. `pool.map` collected the
        # whole round before printing a character of it, so one agent's bad
        # minute was everybody's: a transient connection error on Jordan's call
        # cost forty seconds of staring at nothing while Anna's answer — ready in
        # two — sat in a list waiting for him to finish saying nothing.
        #
        # Arrival order, and that is the honest order: in a room, who spoke
        # after whom is most of the meaning.
        for done in as_completed(pending):
            agent, reply = pending[done], done.result()
            if reply.failed:
                # Loud, and NOT counted as a turn. An agent choosing silence is the
                # thing this repo demonstrates; a request that never ran is a broken
                # group, and printing them the same way makes the demonstration a
                # lie — three calm "stayed quiet" lines in 0.0s while nothing had
                # happened at all.
                print(f"{BAD}  {agent.name} did not answer — {reply.error}{OFF}")
                failed.append(agent.name)
                continue
            if not reply.spoke:
                # Said once per message you type, not once per turn. One line of
                # yours can reach an agent twice — directly, then again carrying
                # what somebody answered — and printing "stayed quiet" both times
                # reads as a stutter rather than as two decisions. The first one
                # already says what the second would.
                if agent.name not in quiet:
                    print(f"{DIM}  {agent.name} stayed quiet{OFF}")
                    quiet.add(agent.name)
                continue
            # Print first, speak second.
            #
            # The gateway used to synthesise inside the turn and hand the clip
            # back as a MEDIA marker, which meant the LINE did not arrive until
            # the MP3 existed — two seconds, measured, of a room with nothing in
            # it while nobody was thinking. It returns words now, so the words
            # are on screen immediately and this asks for the voice afterwards.
            #
            # `split` still runs because an agent can attach media of its own —
            # a file it wrote and meant to send — and that is not this.
            attached, text = voice.split(reply.text)
            print(f"{colour(agents, agent.name)}  {agent.name}: {text}{OFF}")
            out.append(Line(agent.name, text))

            # In this agent's own voice, decided from its name, so it is the
            # same voice the browser would give it. Best effort by construction:
            # `speak` swallows everything and returns None, and a line you can
            # read is worth more than one you can hear.
            audio = attached or voice.speak(
                text, voice_id=voice.voice_for(agent.name, [a.name for a in agents])
            )
            if audio:
                play(audio)
    return out


def introduce(agents: list[Agent], chat: str, people: list[str]) -> None:
    """Open the chat for each agent and tell it who is in the room.

    Without this an agent knows only its own name and cannot tell a question
    aimed at somebody else from one aimed at itself.

    It costs a turn per agent, so it is announced: the prompt used to be drawn
    first and then sit there for several seconds looking hung, and anything
    typed into that gap went nowhere because input() had already been called.
    Introductions run in parallel for the same reason the rounds do.
    """
    who = roster(agents, people)
    # Who each of them is, drawn fresh for this room, and carried inside the
    # introduction they were already getting. A second System message would be a
    # second turn per agent and double a wait that is already the slowest thing
    # here. Identity first, then the situation: the roster ends with how to
    # write a reply, which is the instruction worth having last.
    hands = cast(REPO, [a.name for a in agents])
    print(f"{DIM}introducing {len(agents)} agents…{OFF}", end="", flush=True)

    problems: list[str] = []

    def one(pair: tuple[Agent, str | None]) -> None:
        agent, persona = pair
        open_chat(agent, chat)
        opening = who.format(you=agent.name)
        if persona:
            opening = briefing(persona) + "\n\n" + opening
        reply = deliver(agent, chat, Line("System", opening))
        if reply.failed:
            problems.append(f"{agent.name}: {reply.error}")

    with ThreadPoolExecutor(max_workers=len(agents)) as pool:
        list(pool.map(one, zip(agents, hands, strict=True)))
    print(f"\r{' ' * 40}\r", end="", flush=True)
    # An introduction that failed means that agent never learned who is in the
    # room. Better said here than discovered later as an agent answering
    # questions meant for somebody else.
    for problem in problems:
        print(f"{BAD}  could not introduce {problem}{OFF}")


def main() -> None:
    agents = load_agents(REPO)
    if not agents:
        sys.exit("no group.json — run scripts/group_up.py first")

    people = ["Fabri"]
    chat = ROOM

    # Introduced only the first time anybody opens it. The agents were told who
    # is in the room and who they are when it was made, they remember it, and
    # saying it again costs a turn each to repeat something they already know.
    #
    # There is no `--session` any more, and no `group-<now>`. Minting one per
    # launch is how seventeen conversations appeared in an afternoon of opening
    # the menu, none of them the one you had been talking in.
    if not all(holds(agent, chat) for agent in agents):
        introduce(agents, chat, people)

    print(f"{BOLD}the room{OFF}")
    print(f"{DIM}{', '.join(people + [a.name for a in agents])}{OFF}")
    print(f"{DIM}name one of them to reach them — or /mode, /quit{OFF}")
    print(f"{DIM}mode: {mode_of(agents, chat)}{OFF}\n")

    while True:
        try:
            text = input(f"{BOLD}> {OFF}").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return
        if not text:
            continue
        if text in ("/quit", "/q"):
            return
        if text.split(maxsplit=1)[0] in ("/mode", "/m"):
            set_mode(agents, chat, text)
            continue
        started = time.monotonic()
        quiet: set[str] = set()
        failed: list[str] = []
        pending = [Line(people[0], text)]

        # No cap on how far a line travels. What ends a round is that nobody was
        # named — a reply only reaches the agents it speaks to, so a
        # conversation stops when it stops being addressed to anyone, the way
        # one does. A counter would end it somewhere else, on a number.
        #
        # Two agents who keep naming each other will keep going. Ctrl-C is the
        # way out, and it drops back to the prompt rather than taking the client
        # with it.
        try:
            while pending:
                next_round: list[Line] = []
                for line in pending:
                    next_round += round_of(
                        agents, chat, line, quiet=quiet, failed=failed
                    )
                pending = next_round
        except KeyboardInterrupt:
            print(f"\n{DIM}  stopped{OFF}")

        # No tally. It counted deliveries rather than agents — three of them
        # answering one message can run seven turns — so "3/7 spoke" read as
        # three of seven agents and described nothing anybody wanted to know.
        # What was reached and what stayed quiet is already on the screen, line
        # by line.
        if failed:
            # Except this. A round where nobody could be reached looks exactly
            # like a quiet one, and it is not.
            print(f"{BAD}  {len(set(failed))} unreachable{OFF}")
        print(f"{DIM}  {time.monotonic() - started:.1f}s{OFF}\n")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print()
