# QA

## The standup

```
steeve, daily standup, pass-it-on. say your one thing — what you're working on
or stuck on — then name ONE person who has not gone yet. if everyone has
gone, name nobody and close by saying the one thing we should all agree on.
```

One line, and it exercises nearly everything at once, which is why it is the
one worth typing first.

### What it should do

- **Steve answers, the other two stay quiet.** Steve is named; they are not. Three
  agents reading the same line and two of them deciding it was not theirs is
  the whole demonstration.
- **Steve hands off by name**, and whoever Steve named answers next — because that
  reply reaches both of them and each decides for itself.
- **The chain runs once through everybody**, in whatever order they hand it on.
- **It ends by itself.** The last one names nobody, so nobody answers, so the
  round is over. Nothing counts turns; a round ends when a line arrives that
  nobody thought was for them.
- **Each of them says something a different person would say**, because each
  drew a different persona out of `personas/`. The SRE talks about what happens
  at 3am; the designer talks about what the user sees next. If two answers are
  interchangeable, the personas are not landing.

### What to watch for

| | |
|---|---|
| everyone answers | addressing is not working — they should not all speak |
| nobody answers | Steve was not recognised as addressed |
| it does not stop | somebody kept naming people who had already gone |
| two agents sound the same | the cast is not reaching them, or two drew the same persona |
| the text and the voice arrive together | the turn is synthesising again; it should print, then speak |
| a reply appears off-screen | the transcript did not follow your own message |

Then press **Clear** and run it again: the agents should have no memory of the
first round, and should still be the same people.
