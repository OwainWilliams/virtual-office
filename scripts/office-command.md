---
description: Move this Claude Code session into the Virtual Office
allowed-tools: Bash(node:*)
---

Tell the user what happened, in one or two sentences, from this output:

!`node "REPLACE_WITH_PATH_TO_VIRTUAL_OFFICE/scripts/adopt.mjs" $ARGUMENTS`

If it says the office said no or could not be reached, repeat the reason and stop. Otherwise say the
guest has taken over a copy of this conversation in the office, and that you will not do any more work here.
