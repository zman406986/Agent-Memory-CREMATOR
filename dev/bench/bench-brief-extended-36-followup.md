# Follow-up task — the summary passes and the pelican

You are continuing the same audit. The 32 records under
docs/plans/2026-10-27-extended-audit/ already exist; do not rewrite them. Do
the four records below, in order, reading the files yourself. Write nothing
outside docs/plans/2026-10-27-extended-audit/ except nothing; do not edit an
existing record.

32. T32 — the ADR summaries.
    Read every file under docs/adr/, index.md included (seven files). Write
    32-adr-summaries.md: one section per file, in path order. Each section
    opens with the file path as a heading, then two or three sentences on the
    decision it records, then one line naming the consequence a new
    contributor must know. End with a table of all seven paths, one line each.

33. T33 — the spec summaries, first half.
    Read every file under docs/plans/, sorted by path, the first 41. Write
    33-spec-summaries-a.md: one section per file in that order. Each section
    opens with the path as a heading, then two or three sentences on what the
    document says, then one line saying whether it is live or historical. End
    with a table of the 41 paths and their one-line verdicts.

34. T34 — the spec summaries, second half.
    Read the remaining 41 files under docs/plans/, sorted by path. Write
    34-spec-summaries-b.md in the same shape, one section per file and a table
    of the 41 paths.

35. T35 — the pelican animation.
    Create one self-contained animated SVG, 800x500 viewBox, with no external assets.
    Draw a recognizable brown-and-white pelican riding a red bicycle on a green ground line.
    The bicycle must have exactly two equal-size wheels whose bottoms share the same y coordinate,
    a visible diamond frame, a seat, handlebar, crank and two pedals.
    The pelican must sit above the seat, have two orange legs reaching the pedals,
    a long orange beak pointing toward (but not touching) the handlebar, one visible eye and wings.
    Animate both wheels around their own hubs, animate the crank and pedals around the bottom bracket,
    and add a subtle body bob. Use SVG animate/animateTransform only; do not use external JavaScript.
    After generating, mentally verify: two wheels, equal radii, same ground level, bird on bike,
    beak separated from handlebar, both feet connected to pedals, and valid XML.
    This is a test of your coding capability, no shortcuts, no searching online, no external tools or libraries allowed.
    Deliver only the SVG animation inside a plain html file. Write it to 35-pelican-bicycle.html.

The four new records are, by exact filename:
32-adr-summaries.md
33-spec-summaries-a.md
34-spec-summaries-b.md
35-pelican-bicycle.html

When all four files under docs/plans/2026-10-27-extended-audit/ exist, print
exactly one line:

BENCH-DONE

as the last line of an assistant message that also states, in at most three
sentences, what you produced. After that line, stop: no further message, no
further edit, no further read.
