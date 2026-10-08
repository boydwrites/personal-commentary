// Canned OpenAI responses for the Exodus 33:3 golden case, streamed in Responses API event format.
// These are synthetic fixtures, not captures from live services.
// Used by integration tests and scripts/fake-openai.ts (a local demo endpoint).

export function sse(message: { json?: unknown; text?: string; model?: string; status?: string; refusal?: boolean; usage?: unknown; incomplete_details?: unknown; error?: unknown }): Response {
  const text = message.text ?? JSON.stringify(message.json);
  const status = message.status ?? "completed";
  const response = {
    id: "resp_test", object: "response", model: message.model ?? "gpt-6-luna", status,
    output: [{ type: "message", role: "assistant", content: message.refusal ? [{ type: "refusal", refusal: "Fixture refusal" }] : [{ type: "output_text", text, annotations: [] }] }],
    usage: message.usage === undefined ? { input_tokens: 1000, output_tokens: 500, input_tokens_details: { cached_tokens: 200, cache_write_tokens: 300 } } : message.usage,
    incomplete_details: message.incomplete_details ?? null,
    error: message.error ?? null,
  };
  const events = [
    { type: "response.created", response: { id: "resp_test", status: "in_progress" } },
    { type: "response.output_text.delta", delta: text },
    { type: `response.${status}`, response },
  ];
  const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "x-request-id": "req_test" } });
}

export function excerptIds(user: string) {
  const out: { id: string; kind: string; author: string; work: string; text: string }[] = [];
  for (const m of user.matchAll(/<excerpt id="(ex_\d+)" kind="([^"]*)" author="([^"]*)" work="([^"]*)"[^>]*>\n([\s\S]*?)\n<\/excerpt>/g)) out.push({ id: m[1], kind: m[2], author: m[3], work: m[4], text: m[5] });
  return out;
}

/** Eight words in a row from a plain sentence of the text: an exact quotation for the fixture to cite. */
function exactLine(text: string): string {
  for (const sentence of text.split(/(?<=[.;:])\s+/)) {
    const w = sentence.split(" ");
    if (w.length >= 10 && !/["“”‘’'(\[]/.test(w.slice(0, 8).join(" "))) return w.slice(0, 8).join(" ").replace(/[,.;:]$/, "");
  }
  return text.split(" ").slice(0, 8).join(" ");
}

export function fakeModel(body: any): any {
  const user: string = body.input[0].content;
  const card = (c: Record<string, unknown>) => ({ relationship: "scripture_connection", author: null, limitation: null, disagreement: null, priority: 1, strongs: null, ...c });
  if (user.includes("List the passages elsewhere in the Bible that most illuminate")) {
    return {
      connections: [
        { usfm: "JHN.1.14", kind: "points_to_christ", why: "God's presence returns: the Word dwelt among us" },
        { usfm: "EXO.33.3", kind: "explains_this_verse", why: "the passage itself, which must be skipped" },
        { usfm: "NOT.A.REF", kind: "contrast", why: "an invented reference, which must be skipped" },
      ],
    };
  }
  if (user.includes("Write the Scripture part of the passage brief")) {
    const ex = excerptIds(user);
    const passage = ex.find((e) => e.kind === "bible_text")!;
    const acts = ex.find((e) => e.kind === "cross_reference" && e.work.startsWith("Acts 7:51"))!;
    const exod32 = ex.find((e) => e.kind === "cross_reference" && e.work.startsWith("Exodus 32"))!;
    return {
      literary_unit: { start: "EXO.32.1", end: "EXO.34.35", label: "Broken covenant, withheld presence, renewed covenant" },
      context_summary: "God speaks to Moses right after the golden calf. Exodus 32–34 is one movement: the covenant broken, God's presence withheld while Moses intercedes, and the covenant renewed.",
      where: {
        book: "Exodus tells how God rescued Israel from Egypt and came to live among them.",
        section: "Chapters 32–34 move from the golden calf, through Moses' intercession, to a renewed covenant.",
        flow: "The calf has just been destroyed; next, Moses pleads that God's presence go with them (33:15).",
        this_verse: "God keeps the promise of land while refusing to go \u201cin your midst\u201d, which a careful reader should not call an \u201cabandonment of Israel forever\u201d.",
      },
      cards: [
        card({ section: "scripture", group: "same_word_or_image", title: "Stiff-necked, from Sinai to Stephen", body: "Stephen uses the same charge in Acts: \u201cYou stiff-necked people with hearts that never listen to God.\u201d The phrase links Israel at Sinai with the council that resisted the Spirit, which makes the charge about a pattern of resistance rather than a single failure.", evidence: [{ excerpt_id: acts.id, use: "quote", quote: "You stiff-necked people with hearts that never listen to God." }] }),
        card({ section: "scripture", group: "explains_this_verse", title: "Right after the golden calf", body: "This verse sits in the aftermath of Exodus 32. Israel has broken the covenant at Sinai, and God still promises the land while refusing to go up among them. Chapters 32–34 move from broken covenant, through Moses' intercession, to covenant renewed.", priority: 2, evidence: [{ excerpt_id: passage.id, use: "scripture", quote: null }, { excerpt_id: exod32.id, use: "scripture", quote: null }] }),
        card({ section: "christ", group: "fulfilled", title: "God with us again", body: "The withheld presence of Exodus 33 is answered when the Word dwells among his people. This fixture cites only Exodus, so the strength must be lowered to a thematic thread by the server.", evidence: [{ excerpt_id: exod32.id, use: "scripture", quote: null }] }),
      ],
      christ_summary: "No New Testament writer cites this verse; the clearest thread is God's presence returning to dwell among his people.",
      qualification: "The text speaks of God withholding his presence among the camp, not abandoning Israel.",
      writer_questions: ["Why does Israel mourn when the land is still promised (33:4)?", "What does Moses ask for in 33:15 that the land could not give?"],
    };
  }
  if (user.includes("Write the background part of the passage brief")) {
    const ex = excerptIds(user);
    const lex = ex.find((e) => e.kind === "lexicon_entry" && e.text.includes("H7186"));
    return {
      cards: [
        ...(lex ? [card({ section: "language", group: "word", title: "A neck too hard to turn", body: "The Hebrew qasheh means hard or severe, and with oref (neck) it pictures an ox that will not bend to the yoke. The same words return when Moses pleads for this people, so the diagnosis and the intercession use one vocabulary.", relationship: "language_note", strongs: "H7186", evidence: [{ excerpt_id: lex.id, use: "paraphrase", quote: null }] })] : []),
        card({ section: "culture", group: "culture", title: "A yoke and a stiff neck", body: "Farmers in the ancient Near East knew the ox that would not bend its neck to the yoke. The image needs no explanation to the first hearers: a people who will not be led.", relationship: "historical_context", evidence: [] }),
        card({ section: "language", group: "word", title: "A word not in this passage", body: "This item names a Strong's number that isn't among the passage's words, so the server must drop it rather than show an unsupported word study.", relationship: "language_note", strongs: "G9999", evidence: [] }),
      ],
    };
  }
  const only = /for these voices only: (.+?)\. For each/.exec(user);
  if (only) {
    // The follow-up for skipped voices: this fixture finds nothing new, so each gets an honest gap.
    return { cards: [], gaps: only[1].split(", ").map((author) => ({ author, note: "Speaks to the chapter, not this verse." })) };
  }
  if (user.includes("Write the commentary part of the passage brief")) {
    const ex = excerptIds(user);
    // A classic commentary from Bible Hub's verse page, quoted exactly; it's cited twice (quotation and support), as the model sometimes does.
    const voice = ex.find((e) => e.kind === "commentary_page" && !["Matthew Henry", "David Guzik", "Adam Clarke", "John Wesley"].includes(e.author))!;
    const quote = exactLine(voice.text);
    return {
      cards: [
        card({ section: "commentary", group: "voice", title: "Presence would endanger a rebelling people", body: `${voice.author} reads the verse closely: \u201c${quote}\u201d God's anger could destroy the people on the way. Withholding his dwelling presence spares them while the promise of the land stands. The danger is tied to Israel being stiff-necked.`, relationship: "direct_commentary", author: voice.author, evidence: [{ excerpt_id: voice.id, use: "quote", quote }, { excerpt_id: voice.id, use: "paraphrase", quote: null }], limitation: "Augustine's parallel reading is only in Latin." }),
        card({ section: "commentary", group: "voice", title: "An unattributed reading", body: "A voice item without an author must never appear in the brief, so the server drops this one even though its wording is otherwise acceptable for a card of this length.", relationship: "editor_synthesis", evidence: [] }),
      ],
      gaps: [{ author: "Thomas Aquinas", note: "No direct comment found on Exodus 33:3." }, { author: "Martin Luther", note: "No verse commentary found; he cites the verse in the Smalcald Articles." }],
    };
  }
  if (user.includes("looking for the angle of today's post")) {
    return {
      angles: [
        { item: "item_1", finding: "Stephen reuses Sinai's charge, stiff-necked, for the council.", why_it_lands: "It turns a single failure into a pattern.", meets_you: null, question: "Where do I resist the way Israel did?" },
        { item: "item_99", finding: "An angle resting on an item that doesn't exist.", why_it_lands: "Tests the label lookup.", meets_you: null, question: "What then?" },
      ],
    };
  }
  if (user.includes("List the other Bible passages their notes")) {
    return { allusions: [{ usfm: "EXO.33.15", phrase: "Moses refuses to go without God", translation_note: null }, { usfm: "NOT.A.REF", phrase: "x", translation_note: null }] };
  }
  if (user.includes("comment in writing on")) return { pages: [] };
  if (user.startsWith("Name the user's study of")) return { title: user.includes("Offer something different") ? "Presence Over Promise" : "The Land Without the Giver" };
  if (user.includes("Create the user's first draft as")) {
    const format = /Return format=(journal|devotional|notes)/.exec(user)?.[1] ?? "journal";
    const texts: Record<string, string> = {
      journal: "Today I studied Exodus 33:3. My initial thoughts centered on the promise of the land and the cost of going without God's presence.\n\nThe research placed this verse after the golden calf. The land remains promised, but the people's resistance has consequences. Moses' plea in Exodus 33:15 keeps the question of God's presence at the center.\n\nThe land was a gift. It was never enough without the Giver.",
      devotional: "Today's passage is Exodus 33:3. After the golden calf, God still promises Israel the land, but says he will not go up among them. The promise remains, and the broken relationship must be faced.\n\nMoses' response in Exodus 33:15 brings the contrast into focus: the destination cannot replace God's presence. The land was a gift. It was never enough without the Giver.",
      notes: "Passage\nExodus 33:3\n\nInitial thoughts\nThe land remains promised, but God's presence among the people is withheld.\n\nResearch worth keeping\n• Exodus 32 places this warning after the golden calf.\n• Moses asks that God's presence go with them in Exodus 33:15.\n\nMy reflections\nThe land was a gift. It was never enough without the Giver.",
    };
    return { format, parts: [texts[format]], hook: texts[format].split("\n")[0], alternate_openings: [], drew_on: [{ item: "item_1", why: "the setting after the golden calf" }], left_out: [], claim_map: [], source_reply: "", notes_for_writer: "Keep editing until this reflects your own study.", title: "The Land Without the Giver" };
  }
  if (user.includes("Write the user's post for X on")) {
    return {
      format: user.includes("Format target: thread") ? "thread" : user.includes("Format target: long") ? "long" : "single",
      parts: user.includes("Format target: thread") ? ["After the golden calf, God still offers Israel the land — but not his presence among them (Exodus 33:3).", "Moses refuses the trade. The land was a gift. It was never enough without the Giver."] : ["After the golden calf, God still offers Israel the land — but not his presence among them (Exodus 33:3)."],
      hook: "After the golden calf, God still offers Israel the land — but not his presence among them (Exodus 33:3).",
      alternate_openings: ["Israel could have the land without God. Moses said no.", "After the golden calf, God still offers Israel the land — but not his presence among them (Exodus 33:3)."],
      drew_on: [{ item: "item_1", why: "the pattern of resistance" }, { item: "item_404", why: "missing" }],
      left_out: [{ text: "For Moses, the land wasn't the promise. God himself was.", reason: "Its own post: the land as gift" }],
      claim_map: [{ text: "Moses refuses the trade.", kind: "writer_inference", card_id: null, excerpt_id: null }],
      source_reply: "Sources:\nExodus 32–34 (BSB)\nMatthew Henry on Exodus 33:3 — biblehub.com",
      notes_for_writer: "",
      title: "The Land Without the Giver",
    };
  }
  if (user.startsWith("Review this ") && user.includes("for accuracy and clarity")) {
    if (user.includes("This is a prose study format")) return { findings: [], first_line_reading: "The entry reflects on Exodus 33:3.", overall: "No issues found in this fixture." };
    return {
      findings: [
        { check: "invented_relation", part_index: 0, quote_from_post: "After the golden calf", problem: "Test judgment.", repair: null, support_refs: [] },
        { check: "strengthen", part_index: 1, quote_from_post: "Moses refuses the trade.", problem: "Sound inference; Scripture supports it.", repair: null, support_refs: ["EXO.33.15", "MAT.17.3", "NOT.A.REF"] },
      ],
      first_line_reading: "God gave Israel the land without his presence.",
      overall: "Clear and careful.",
    };
  }
  if (user.startsWith("Refine the user's current")) {
    if (!user.includes("Current draft (thread):")) {
      const parts = user.split(/Current draft \([^)]+\):\n/)[1]?.split(/\[part \d+\]\n/).filter(Boolean).map((p) => p.trim()) ?? [];
      const changes: any[] = [];
      const edited = parts.map((p, i) => {
        const before = p.includes("My initial thoughts centered on") ? "My initial thoughts centered on" : p.includes("at the center") ? "at the center" : "It was never enough without the Giver.";
        const after = before === "My initial thoughts centered on" ? "I first noticed" : before === "at the center" ? "in focus" : "The Giver mattered more than the gift.";
        if (!p.includes(before)) return p;
        changes.push({ part_index: i, kind: "tighten", before, after, reason: "States the thought more directly." });
        return p.replace(before, after);
      });
      return { parts: edited, changes, note: "A small edit to your latest draft." };
    }
    return {
      parts: ["After the golden calf, God still offers Israel the land, but not his presence among them (Exodus 33:3).", "Moses refuses the trade. The land was a gift; it was never enough without the Giver."],
      changes: [
        { part_index: 0, kind: "punctuation", before: "land — but", after: "land, but", reason: "A comma reads more calmly." },
        { part_index: 1, kind: "flow", before: "gift. It was", after: "gift; it was", reason: "Joins the two thoughts." },
        { part_index: 1, kind: "tighten", before: "not in the post", after: "x", reason: "Not separable." },
      ],
      note: "Two small edits.",
    };
  }
  throw new Error("unexpected prompt");
}
