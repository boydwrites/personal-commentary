# Design notes

Personal Commentary organizes a study around **Read → Research → Write**, with the passage and notebook beside each step. The interface keeps the source material, the reader's words, and model suggestions distinguishable.

## One study, several pieces

A study contains a passage, a notebook, a research brief, and any number of written pieces. A reader can make study notes first, then distill them into a devotional or post without replacing the longer work. Each form retains its own working text and revisions.

The three stages suggest a sequence without locking navigation. Notes remain optional when research or another piece supplies the starting material for a draft.

## Evidence within reach

A finding opens its source rather than sending the reader into a detached citation list. The evidence drawer displays the stored text and highlights a matched quotation. A failed match is visible in the research result; quotation verification does not imply endorsement of the source or interpretation.

Highlighting a line adds it to the notebook with an attribution that distinguishes Scripture, a source's wording, and the brief's own summary. Word studies display definitions and usage from local lexical datasets.

Relevant components: [ResearchCard](../web/src/components/ResearchCard.tsx), [EvidenceDrawer](../web/src/components/EvidenceDrawer.tsx), [WordStudy](../web/src/components/WordStudy.tsx), [Notebook](../web/src/study/Notebook.tsx).

## A useful next action

The study header presents the next meaningful action: start research, move to writing, create a draft, resolve review findings, or finish. A prerequisite becomes an action the reader can take instead of an unexplained disabled control.

Research streams progress while the notebook remains usable. Writing tools show changes and offer undo. Saving has explicit states—Saved, Saving, and Not saved with Retry—so a failed write does not masquerade as success.

Relevant components: [StudyHeader](../web/src/study/StudyHeader.tsx), [WriteStage](../web/src/study/WriteStage.tsx), [writing state](../web/src/study/useWriting.ts), [save status](../web/src/saveStatus.ts).

## Finishing and sharing

Private pieces can be finished and reread without publishing. Sharing to X requires a check of the current wording and the reader's resolution of outstanding judgments. Edits invalidate a prior review. The final posting step opens X's composer.

The finished view collects the passage, pieces, notes, highlights, and research into a page that can be revisited and edited.

## Layout

The central work and adjacent notebook share the same layout through the study. On narrower windows the notebook moves into an accessible panel; the passage remains within reach. Typography separates reading from controls, and light and dark appearances use the same interaction model.

The project uses React, CSS, and local font packages. The native Mac shell hosts the same web interface and owns the local server's lifetime.

## What still needs evaluation

Automated tests verify state transitions and failure handling. They do not establish that readers understand every evidence label, that the workflow works equally well for every passage, or that generated prose meets their editorial expectations. Those questions require observed use and review of live model outputs.
