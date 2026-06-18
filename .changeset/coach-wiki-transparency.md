---
"ai-advisory-board": minor
---

Decision Coach × Business Wiki: the **📚 wiki badge now explains itself**.

- **Sources used** — the badge expands ("📚 wiki · N sources ▸") to list exactly which wiki pages the coach read for that reply (each links to the Knowledge view), plus what it searched for. Captured per turn as `DecisionMessage.wikiUsage`.
- **Added to your wiki** — when your message is ingested back into the wiki, the user turn shows a **📥 Added to your wiki (N)** note listing the new/updated pages (or "nothing new to add"). Captured as `DecisionMessage.wikiIngest` and streamed live via a new `coach_wiki_ingested` event.
