"""Excel number formats, so a viewer can show cells the way Excel does.

Covers the formats people use: separate sections for negatives and zero,
decimals, thousands separators and scaling, percentages, scientific notation,
currency symbols and quoted text, and date and time codes. Anything else, such
as fractions or conditional sections, falls back to General, which always shows
the true value.
"""

import datetime
import math
import re
from decimal import ROUND_HALF_UP, Decimal

MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
_PLACEHOLDERS = "0#?"
_DATE_CODES = re.compile(r"am/pm|a/p|y+|m+|d+|h+|s+(?:\.0+)?|e+|.", re.IGNORECASE)


class _Unsupported(Exception):
    pass


def general(value) -> str:
    """Numbers as Excel's General format shows them (up to 15 significant digits), dates in ISO 8601."""
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            return ""
        if value.is_integer() and abs(value) < 1e15:
            return str(int(value))
        return f"{value:.15g}"
    if isinstance(value, datetime.datetime):
        if value.time() == datetime.time():
            return value.date().isoformat()
        return value.isoformat(sep=" ", timespec="milliseconds" if value.microsecond else "seconds")
    if isinstance(value, datetime.date):
        return value.isoformat()
    if isinstance(value, datetime.time):
        return value.isoformat(timespec="milliseconds" if value.microsecond else "seconds")
    if isinstance(value, datetime.timedelta):
        seconds = round(value.total_seconds())
        sign, seconds = ("-" if seconds < 0 else ""), abs(seconds)
        hours, rest = divmod(seconds, 3600)
        return f"{sign}{hours}:{rest // 60:02}:{rest % 60:02}"
    return "" if value is None else str(value)


def display(value, number_format: str | None) -> str:
    """`value` as a cell with `number_format` shows it, or as General when the format is beyond this module."""
    if isinstance(value, bool) or not isinstance(value, (int, float, datetime.date, datetime.time)):
        return general(value)
    try:
        sections = _sections(number_format or "General")
        if isinstance(value, (datetime.date, datetime.time)):
            return _date(value, _tokens(sections[0]))
        return _number(value, sections)
    except (_Unsupported, ValueError, OverflowError, ArithmeticError, IndexError):
        return general(value)


def _sections(number_format: str) -> list[str]:
    sections, current, quoted, bracket, escaped = [], [], False, False, False
    for char in number_format:
        if escaped:
            escaped = False
        elif char == "\\" and not quoted:
            escaped = True
        elif char == '"' and not bracket:
            quoted = not quoted
        elif char == "[" and not quoted:
            bracket = True
        elif char == "]" and not quoted:
            bracket = False
        elif char == ";" and not quoted and not bracket:
            sections.append("".join(current))
            current = []
            continue
        current.append(char)
    sections.append("".join(current))
    return sections


def _tokens(section: str) -> list[tuple[str, str]]:
    """("lit", text) for text shown as it is, ("ch", c) for each format character."""
    out, i = [], 0
    while i < len(section):
        char = section[i]
        if char == '"':
            end = section.find('"', i + 1)
            end = len(section) if end < 0 else end
            out.append(("lit", section[i + 1:end]))
            i = end + 1
        elif char == "\\":
            out.append(("lit", section[i + 1:i + 2]))
            i += 2
        elif char in "_*":
            # Padding to another character's width, and repeating to fill the cell: not needed in a grid.
            i += 2
        elif char == "[":
            end = section.find("]", i)
            end = len(section) if end < 0 else end
            inner = section[i + 1:end]
            if inner.startswith("$"):
                symbol = inner[1:].split("-")[0]
                if symbol:
                    out.append(("lit", symbol))
            elif re.fullmatch(r"[hms]+", inner, re.IGNORECASE):
                out.extend(("ch", c) for c in inner)
            elif re.match(r"[<>=]", inner):
                raise _Unsupported("conditional section")
            # Colours and other modifiers change nothing in the text.
            i = end + 1
        else:
            out.append(("ch", char))
            i += 1
    return out


def _literal(tokens: list[tuple[str, str]]) -> str:
    return "".join(text for _, text in tokens)


def _number(value: float, sections: list[str]) -> str:
    negative = value < 0
    if negative and len(sections) > 1:
        section, value, sign = sections[1], -value, ""
    elif value == 0 and len(sections) > 2:
        section, sign = sections[2], ""
    else:
        section, sign = sections[0], "-" if negative else ""
        value = abs(value)
    tokens = _tokens(section)
    chars = "".join(text for kind, text in tokens if kind == "ch")
    if not chars.strip() and not any(kind == "lit" for kind, _ in tokens):
        return ""
    if chars.lower().replace(" ", "") in ("general", "") and not any(kind == "lit" for kind, _ in tokens):
        return sign + general(value)
    if "@" in chars or "/" in chars:
        raise _Unsupported("text or fraction format")
    positions = [index for index, (kind, text) in enumerate(tokens) if kind == "ch" and text in _PLACEHOLDERS]
    if not positions:
        if any(kind == "ch" and text.isalpha() for kind, text in tokens):
            raise _Unsupported("letters outside quotes")
        # A section of text only, such as "High" or "-" for zero.
        return sign + _literal(tokens)
    start, end = positions[0], positions[-1]
    # The number block runs from the first to the last digit placeholder, with its
    # decimal point, separators, exponent and any scaling commas straight after it.
    while start > 0 and tokens[start - 1] == ("ch", "."):
        start -= 1
    while end + 1 < len(tokens) and tokens[end + 1][0] == "ch" and tokens[end + 1][1] in ",.":
        end += 1
    block_tokens = tokens[start:end + 1]
    if any(kind == "lit" for kind, _ in block_tokens):
        raise _Unsupported("text inside the number")
    block = "".join(text for _, text in block_tokens)
    prefix, suffix = tokens[:start], tokens[end + 1:]
    value *= 100 ** sum(text == "%" for kind, text in tokens if kind == "ch")
    return sign + _literal(prefix) + _digits(value, block) + _literal(suffix)


def _digits(value: float, block: str) -> str:
    match = re.fullmatch(r"([0#?,]*)(\.[0#?,]*)?([eE][+-][0#?]+)?", block)
    if not match:
        raise _Unsupported(block)
    whole, fraction, exponent = match.group(1), (match.group(2) or "")[1:], match.group(3)
    last = fraction if match.group(2) else whole
    scale = len(last) - len(last.rstrip(","))
    if match.group(2):
        fraction = fraction.rstrip(",")
    else:
        whole = whole.rstrip(",")
    value /= 1000 ** scale
    fraction = fraction.replace(",", "")
    required, places = fraction.count("0"), len(fraction)
    if exponent:
        power = 0 if value == 0 else math.floor(math.log10(value))
        mantissa = value / 10 ** power
        if round(mantissa, places) >= 10:
            power, mantissa = power + 1, mantissa / 10
        text = _fixed(mantissa, whole, places, required, "." in block)
        sign = "-" if power < 0 else "+" if exponent[1] == "+" else ""
        return f"{text}{exponent[0]}{sign}{abs(power):0{len(exponent) - 2}d}"
    return _fixed(value, whole, places, required, "." in block)


def _fixed(value: float, whole: str, places: int, required: int, point: bool) -> str:
    rounded = Decimal(repr(value)).quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_UP)
    integer, _, decimals = format(rounded, "f").partition(".")
    decimals = decimals.ljust(places, "0")[:places]
    while len(decimals) > required and decimals.endswith("0"):
        decimals = decimals[:-1]
    minimum = whole.count("0")
    if integer == "0" and minimum == 0:
        integer = ""
    integer = integer.zfill(minimum)
    if "," in whole and integer:
        head = len(integer) % 3 or 3
        integer = ",".join([integer[:head]] + [integer[i:i + 3] for i in range(head, len(integer), 3)])
    # Like Excel, a format with a decimal point shows it even when no decimals remain ("0.##" shows 5.).
    return integer + ("." + decimals if point else "")


def _date(value, tokens: list[tuple[str, str]]) -> str:
    chars = "".join(text for kind, text in tokens if kind == "ch").lower()
    if not chars.strip() or "general" in chars:
        return general(value)
    if isinstance(value, datetime.datetime):
        moment = value
    elif isinstance(value, datetime.date):
        moment = datetime.datetime.combine(value, datetime.time())
    else:
        moment = datetime.datetime.combine(datetime.date(1899, 12, 31), value)
    parts: list[tuple[str, str]] = []
    run: list[str] = []
    for kind, text in tokens + [("lit", "")]:
        if kind == "ch":
            run.append(text)
            continue
        parts.extend(("code", code) for code in _DATE_CODES.findall("".join(run)))
        run = []
        if text:
            parts.append(("lit", text))
    codes = [text.lower() for kind, text in parts if kind == "code"]
    if not any(code[0] in "ymdhse" for code in codes if code.isalpha() or "." in code):
        raise _Unsupported("no date codes")
    twelve = any(code in ("am/pm", "a/p") for code in codes)
    out = []
    for index, (kind, text) in enumerate(parts):
        code = text.lower()
        if kind == "lit" or not (code[0] in "ymdhsea" and (code.isalpha() or "/" in code or "." in code)):
            out.append(text)
            continue
        if code[0] == "m" and _is_minute(parts, index):
            out.append(f"{moment.minute:02d}" if len(code) > 1 else str(moment.minute))
        elif code[0] == "m":
            out.append([str(moment.month), f"{moment.month:02d}", MONTHS[moment.month - 1][:3],
                        MONTHS[moment.month - 1], MONTHS[moment.month - 1][0]][min(len(code), 5) - 1])
        elif code[0] in "ye":
            out.append(f"{moment.year % 100:02d}" if code[0] == "y" and len(code) <= 2 else str(moment.year))
        elif code[0] == "d":
            out.append([str(moment.day), f"{moment.day:02d}", DAYS[moment.weekday()][:3], DAYS[moment.weekday()]][min(len(code), 4) - 1])
        elif code[0] == "h":
            hour = (moment.hour % 12 or 12) if twelve else moment.hour
            out.append(f"{hour:02d}" if len(code) > 1 else str(hour))
        elif code[0] == "s":
            whole, _, digits = code.partition(".")
            out.append(f"{moment.second:02d}" if len(whole) > 1 else str(moment.second))
            if digits:
                out.append("." + f"{moment.microsecond:06d}"[:len(digits)])
        elif code in ("am/pm", "a/p"):
            marker = ("AM" if moment.hour < 12 else "PM")[:2 if code == "am/pm" else 1]
            out.append(marker if text[0].isupper() else marker.lower())
        else:
            out.append(text)
    return "".join(out)


def _is_minute(parts: list[tuple[str, str]], index: int) -> bool:
    """An m code means minutes right after hours or right before seconds."""
    codes = [(i, text.lower()) for i, (kind, text) in enumerate(parts) if kind == "code" and text[:1].isalpha()]
    position = next(n for n, (i, _) in enumerate(codes) if i == index)
    before = codes[position - 1][1] if position > 0 else ""
    after = codes[position + 1][1] if position + 1 < len(codes) else ""
    return before.startswith("h") or after.startswith("s")
