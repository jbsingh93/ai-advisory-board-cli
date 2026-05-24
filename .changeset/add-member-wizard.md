---
"ai-advisory-board": minor
---

Type-first Add Member wizard with AI fill during creation.

- **Pick an archetype first:** "Add board member" now opens a two-step wizard — choose 🌟 Inspired by a well-known person, 🎓 Top 1% expert, or 🧑‍💼 Practitioner — and step 2 shows only the inputs that type needs (Name+Title for a person; Field/Domain for an expert; Role + Industry/Domain for a practitioner). Editing an existing member still uses the flat all-fields form.
- **AI fill works *before* save:** a Manual ⇄ AI toggle (AI by default) lets a first-time user generate everything during creation. The old "✨ Enhance with AI" button refused to run until the member was already saved; the wizard adds a stateless `POST /api/members/enhance-preview` that runs a web-research call to fill `expertise[]` and then the persona enhancer, dropping the results into editable fields to review before saving — nothing is persisted until you hit Save.
- **Descriptive-label naming for archetypes:** an expert saves as `"{Field} Expert"` / `Top 1% Expert`, a practitioner as `{Role}` / `"{Domain} practitioner"` — no fabricated identities.
- **BFI-2 + Cognitive Architecture for all three personas:** the famous-person prompt now matches the original AAB template (Psychometric Profile BFI-2 "I-statements" + step-by-step Cognitive Architecture), and the expert and practitioner prompts were reframed from person-locked to field/role-based archetypes and gained the same BFI-2 + cognitive-process output. All three keep the hardened JSON output contract.
