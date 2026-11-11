"""Fuzzy entity resolution - adapted from the AI Studio build's mechanism
(Jaro-Winkler name matching + OCR confusion normalisation), reimplemented
for the production engine. Used only as a labelled fallback rung in
candidate resolution: exact evidence always wins, fuzzy matches are
recorded as matched_by = ocr_reference / fuzzy_payer so they stay auditable.
"""

def _jaro(s1, s2):
    if s1 == s2: return 1.0
    l1, l2 = len(s1), len(s2)
    if not l1 or not l2: return 0.0
    dist = max(l1, l2) // 2 - 1
    m1 = [False] * l1; m2 = [False] * l2
    matches = 0
    for i, c in enumerate(s1):
        lo, hi = max(0, i - dist), min(i + dist + 1, l2)
        for j in range(lo, hi):
            if not m2[j] and s2[j] == c:
                m1[i] = True; m2[j] = True; matches += 1; break
    if not matches: return 0.0
    t, k = 0, 0
    for i in range(l1):
        if m1[i]:
            while not m2[k]: k += 1
            if s1[i] != s2[k]: t += 1
            k += 1
    return (matches / l1 + matches / l2 + (matches - t // 2) / matches) / 3

def jaro_winkler(s1, s2, prefix_weight=0.1):
    j = _jaro(s1.lower(), s2.lower())
    prefix = 0
    for a, b in zip(s1.lower(), s2.lower()):
        if a == b and prefix < 4: prefix += 1
        else: break
    return j + prefix * prefix_weight * (1 - j)

_OCR_SUBS = {"1": "I", "0": "O", "5": "S", "8": "B", "I": "1", "O": "0", "S": "5", "B": "8", "l": "1", "Z": "2", "2": "Z"}

def ocr_variants(ref):
    """Variants of a reference token under common OCR confusions.
    Single-position substitutions are generated across the WHOLE token -
    scanners mangle digits into letters inside the number (INV-1O05) at
    least as often as they mangle the alphabetic prefix (1NV-1005). The
    full-substitution pass stays prefix-only, which bounds the variant
    count; a variant is only ever a lookup key against the ledger, so a
    variant that names no real invoice costs nothing."""
    out = {ref}
    if "-" in ref:
        head, tail = ref.split("-", 1)
    else:
        head, tail = ref, ""
    suffix = ("-" + tail) if tail else ""
    chars = list(head)
    for i, c in enumerate(chars):
        if c in _OCR_SUBS:
            v = chars.copy(); v[i] = _OCR_SUBS[c]
            out.add("".join(v) + suffix)
    # full two-substitution pass for badly mangled prefixes
    v = [(_OCR_SUBS.get(c, c)) for c in chars]
    out.add("".join(v) + suffix)
    # single-position substitutions inside the numeric tail
    tchars = list(tail)
    for i, c in enumerate(tchars):
        if c in _OCR_SUBS:
            v = tchars.copy(); v[i] = _OCR_SUBS[c]
            out.add(head + "-" + "".join(v))
    return out

def best_fuzzy_customer(payer, customers, threshold=0.88):
    best, score = None, 0.0
    for cust in customers:
        sc = jaro_winkler(payer, cust)
        if sc > score: best, score = cust, sc
    return (best, round(score, 3)) if score >= threshold else (None, round(score, 3))
