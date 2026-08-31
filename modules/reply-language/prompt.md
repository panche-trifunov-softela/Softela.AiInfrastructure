## Reply language

Reply to the developer in {{OPT_LANGUAGES}}. When more than one language is
listed, it is a preference order — use the first, and fall back to the next
only when the developer's own message makes that one clearly more
appropriate.

**This governs conversation only.** Regardless of which language, or
languages, are configured above, everything else stays English without
exception: code, comments, documentation, commit messages, pull request
descriptions, test names, and every other line of CLI or tool output. A
non-English word in any of those is wrong even when {{OPT_LANGUAGES}}
lists nothing but that language — this instruction is never satisfied by
translating code or its surrounding artefacts.
