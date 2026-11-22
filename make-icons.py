#!/usr/bin/env python3
"""Generate the panel icons: Yaru's charging-battery layout (body on the right,
glyph in the left 5px where the bolt sits) with a service glyph instead of the bolt.

Run from the extension directory; writes icons/<service>-<level>-symbolic.svg.
"""
from pathlib import Path

# Body outline of Yaru's battery-level-*-charging-symbolic.svg, minus the bolt subpath
BODY = (
    "m9 0v1.0117c-0.77194 0.016396-1.3991 0.076294-1.9375 0.37305a1.88 1.88 0 0 0-0.83789 0.99805"
    "c-0.165 0.437-0.22461 0.96019-0.22461 1.6172v7h-0.00586v1c0 0.658 0.059609 1.1792 0.22461 1.6172"
    " 0.164 0.439 0.46189 0.78909 0.83789 0.99609 0.753 0.415 1.6736 0.37172 2.9316 0.38672h2.0117"
    "c1.258-0.015 2.1786 0.02828 2.9316-0.38672 0.376-0.207 0.67389-0.55709 0.83789-0.99609"
    " 0.16492-0.438 0.22461-0.95919 0.22461-1.6172h0.005859v-8c0-0.657-0.059609-1.1802-0.22461-1.6172"
    "a1.88 1.88 0 0 0-0.83789-0.99805c-0.53845-0.29675-1.1656-0.35665-1.9375-0.37305v-1.0117z"
    "m1 2h2c1.26 0.015 2.0871 0.059719 2.4531 0.26172 0.184 0.101 0.28872 0.21266 0.38672 0.47266"
    " 0.096996 0.26 0.16016 0.67362 0.16016 1.2656v7h-0.0059v1c0 0.592-0.06316 1.0056-0.16016 1.2656"
    "-0.098 0.259-0.20077 0.37266-0.38476 0.47266-0.36492 0.202-1.196 0.24672-2.455 0.26172h-2"
    "c-1.259-0.015-2.0901-0.05972-2.4551-0.26172-0.184-0.1-0.28677-0.21366-0.38477-0.47266"
    "-0.097-0.26-0.16016-0.67362-0.16016-1.2656v-1h0.0058594v-7c0-0.592 0.063156-1.0056 0.16016-1.2656"
    " 0.098-0.26 0.20272-0.37166 0.38672-0.47266 0.366-0.202 1.1931-0.24672 2.4531-0.26172z"
)

# Glyphs live in the bolt's box (x 0..5, y 3..14), drawn as filled shapes like the bolt
GLYPHS = {
    # Claude: six-ray spark
    "claude": "".join(
        f'<rect x="2.2" y="5.3" width="1.15" height="6.4" rx="0.575" transform="rotate({a} 2.775 8.5)"/>'
        for a in (0, 60, 120)
    ),
    # Codex: terminal prompt ">_"
    "codex": (
        '<rect x="0.05" y="5.05" width="4.8" height="1.1" rx="0.55" transform="rotate(45 0.6 5.6)"/>'
        '<rect x="0.05" y="10.29" width="4.8" height="1.1" rx="0.55" transform="rotate(-45 0.6 10.84)"/>'
        '<rect x="2.4" y="12.4" width="2.8" height="1.1" rx="0.55"/>'
    ),
}


def fill(level):
    """Charge bar like Yaru's: x 8..14, bottom at 13, one unit per 10%, rounded bottom."""
    if level == 0:
        return ""
    top = 13 - level / 10
    cls = ' class="error" fill="#da1636"' if level <= 10 else \
          ' class="warning" fill="#fdc92b"' if level <= 20 else ' fill="#808080"'
    return (f'<path{cls} d="m8 {top:g}v{12 - top:g}c0 0.554 0.446 1 1 1h4'
            f'c0.554 0 1-0.446 1-1v-{12 - top:g}z"/>')


def main():
    out = Path("icons")
    out.mkdir(exist_ok=True)
    for name, glyph in GLYPHS.items():
        for level in range(0, 101, 10):
            svg = (
                '<svg version="1.1" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">\n'
                f' <path d="{BODY}" fill="#808080"/>\n'
                f' <g fill="#808080">{glyph}</g>\n'
                f' {fill(level)}\n'
                '</svg>\n'
            )
            (out / f"{name}-{level}-symbolic.svg").write_text(svg)


if __name__ == "__main__":
    main()
