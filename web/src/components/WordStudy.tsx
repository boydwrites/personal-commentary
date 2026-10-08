// One Hebrew or Greek word, made readable: what it means, how English renders it across the Bible, and the
// best-known verses that use it. All local data (STEPBible, the BSB, and OpenBible's links between verses).
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ExternalLink, X } from "lucide-react";
import { api } from "../api";
import { Dots, Drawer } from "./ui";
import { parseReference, toUsfm } from "../../../shared/refs.ts";

/** "Jude 1:22" → "JUD.1.22" (null when it isn't a reference). */
export function usfmOfRef(label: string | null | undefined): string | null {
  if (!label) return null;
  const p = parseReference(label);
  return p.ok && p.range.v1 !== null ? toUsfm(p.range) : null;
}

type Sense = { depth: number; label: string | null; text: string; refs: string[]; heading?: boolean };
type KeyUse = { ref: string; usfm: string; text: string; rendering: string; mark: [number, number] | null; sameBook: boolean };
export type Word = {
  strong: string; lemma: string; translit: string; gloss: string; partOfSpeech: string; language: "grc" | "he"; testament: string;
  count: number; verses: number; elsewhere: number;
  here: { ref: string; word: string; translit: string; gloss: string } | null;
  renderings: { label: string; count: number }[];
  key: KeyUse[];
  senses: Sense[];
  definition: string;
  url: string;
  all?: { ref: string; usfm: string; rendering: string; here: boolean }[];
};

export function useWord(strong: string | null, at?: string | null, all = false) {
  return useQuery<Word>({
    queryKey: ["word", strong, at ?? null, all],
    queryFn: () => api(`/api/words/${strong}?${new URLSearchParams({ ...(at ? { at } : {}), ...(all ? { all: "1" } : {}) })}`),
    enabled: !!strong,
    staleTime: Infinity,
  });
}

const langName = (w: { language: string }) => (w.language === "he" ? "Hebrew" : "Greek");

/** A verse with the word's English lit, when the BSB's wording shows it. */
function Lit({ text, mark }: { text: string; mark: [number, number] | null }) {
  if (!mark) return <>{text}</>;
  return <>{text.slice(0, mark[0])}<mark className="ws-hit">{text.slice(mark[0], mark[1])}</mark>{text.slice(mark[1])}</>;
}

/** The headword: the word as a lexicon lists it, how to say it, and what kind of word it is. */
export function WordHead({ w, big }: { w: Pick<Word, "lemma" | "translit" | "language" | "strong"> & { partOfSpeech?: string; gloss?: string }; big?: boolean }) {
  const rtl = w.language === "he";
  return (
    <div className={`word-head ${big ? "big" : ""}`}>
      <span className="orig" lang={rtl ? "he" : "grc"} dir={rtl ? "rtl" : "ltr"}>{w.lemma}</span>
      <span className="translit">{w.translit}</span>
      {w.gloss && <span className="ws-gloss">{w.gloss}</span>}
      <span className="strong" title="Strong's number: the word's number in Strong's concordance">{w.partOfSpeech ? `${w.partOfSpeech} · ` : ""}{w.strong}</span>
    </div>
  );
}

/**
 * The study of one word. `compact` leaves out the headword (its container shows one) and starts with fewer senses.
 * `at` is the verse (USFM) the word was met in, so the study can say how it reads there and leave that verse out of "elsewhere".
 */
export function WordStudy({ strong, at, compact = false, showHead = true }: { strong: string; at?: string | null; compact?: boolean; showHead?: boolean }) {
  const q = useWord(strong, at);
  const [allOpen, setAllOpen] = useState(false);
  const [moreSenses, setMoreSenses] = useState(false);
  const [entryOpen, setEntryOpen] = useState(false);
  const all = useWord(allOpen ? strong : null, at, true);
  if (q.isLoading) return <div className="ws ws-loading"><Dots label="Looking up the word" /></div>;
  if (q.error || !q.data) return <p className="ws muted small">{(q.error as Error)?.message ?? "This word couldn't be looked up."}</p>;
  const w = q.data;
  const senses = w.senses.filter((x) => moreSenses || x.depth <= (compact ? 0 : 1));
  const hiddenSenses = w.senses.length - senses.length;
  const otherVerses = w.elsewhere;

  return (
    <div className="ws">
      {showHead && <WordHead w={w} big={!compact} />}
      <p className="ws-explain">
        {w.here ? (
          <>
            One {langName(w)} word from {w.here.ref}, not the whole verse. There it's written{" "}
            <span className="orig-inline" lang={w.language === "he" ? "he" : "grc"}>{w.here.word}</span> ({w.here.translit}) and rendered <b>{w.here.gloss}</b>.{" "}
          </>
        ) : (
          <>A {langName(w)} word{w.partOfSpeech ? ` (${w.partOfSpeech})` : ""}. </>
        )}
        It's used {w.count} time{w.count === 1 ? "" : "s"} in the {w.testament}.
      </p>

      {senses.length > 0 && (
        <section className="ws-sec">
          <h4 className="ws-h">What it means</h4>
          <ul className="ws-senses">
            {senses.map((x, i) =>
              x.heading ? (
                <li key={i} className="ws-sense-head">{x.text}</li>
              ) : (
                <li key={i} className={`ws-sense d${x.depth}`}>
                  {x.label && <span className="ws-label">{x.label}</span>}
                  <span>
                    {x.text}
                    {x.refs.length > 0 && <span className="ws-refs"> · {x.refs.slice(0, 4).join(", ")}{x.refs.length > 4 ? ", …" : ""}</span>}
                  </span>
                </li>
              ),
            )}
          </ul>
          {(hiddenSenses > 0 || moreSenses) && (
            <button className="text-btn ws-more" onClick={() => setMoreSenses((x) => !x)}>
              {moreSenses ? "Fewer senses" : `${hiddenSenses} finer sense${hiddenSenses === 1 ? "" : "s"}`}
            </button>
          )}
        </section>
      )}

      {w.renderings.length > 1 && (
        <section className="ws-sec">
          <h4 className="ws-h">How English renders it</h4>
          <div className="ws-renderings">
            {w.renderings.map((r) => (
              <span key={r.label} className="ws-rendering">{r.label} <span className="ws-n">×{r.count}</span></span>
            ))}
          </div>
          <p className="ws-note">Word-for-word English across its {w.count} uses. One word, several shades: the verse decides which.</p>
        </section>
      )}

      {w.key.length > 0 && (
        <section className="ws-sec">
          <h4 className="ws-h">
            Where else it's used
            <span className="ws-sub">{w.key.length < otherVerses ? `the best-known of ${otherVerses} other verses` : `${otherVerses} other verse${otherVerses === 1 ? "" : "s"}`}</span>
          </h4>
          <ul className="ws-uses">
            {w.key.map((u) => (
              <li key={u.usfm} data-keep={`${u.ref} (BSB)`}>
                <span className="ws-use-ref">{u.ref}{u.sameBook && <span className="ws-same" title="In the same book as your passage"> · same book</span>}</span>
                <span className="ws-use-text"><Lit text={u.text} mark={u.mark} /></span>
                {!u.mark && <span className="ws-use-wfw">word for word: {u.rendering}</span>}
              </li>
            ))}
          </ul>
          {otherVerses > w.key.length && (
            <button className="text-btn row ws-more" onClick={() => setAllOpen((x) => !x)} aria-expanded={allOpen}>
              {allOpen ? "Hide the full list" : `All ${w.verses} verses`}
              <ChevronDown className="lucide" style={{ width: 14, height: 14, transform: allOpen ? "rotate(180deg)" : undefined }} />
            </button>
          )}
          {allOpen && (all.isLoading ? <Dots label="Listing every use" /> : all.data?.all && (
            <ul className="ws-all rise">
              {all.data.all.map((u) => (
                <li key={u.usfm} className={u.here ? "here" : undefined}>
                  <b>{u.ref}</b> {u.rendering}{u.here && <span className="ws-same"> · your passage</span>}
                </li>
              ))}
              {all.data.verses > all.data.all.length && <li className="muted">…and {all.data.verses - all.data.all.length} more on STEPBible.</li>}
            </ul>
          ))}
        </section>
      )}

      <section className="ws-sec">
        <button className="text-btn row ws-more" onClick={() => setEntryOpen((x) => !x)} aria-expanded={entryOpen}>
          {entryOpen ? "Hide the lexicon entry" : "The full lexicon entry"}
          <ChevronDown className="lucide" style={{ width: 14, height: 14, transform: entryOpen ? "rotate(180deg)" : undefined }} />
        </button>
        {entryOpen && (
          <div className="lexicon rise">
            <p className="ws-legend">
              {w.language === "he"
                ? "Numbered senses run from general (1) to specific (1a, 1a1). Qal, Niphal, Piel… are the verb's stems: plain, passive, intensive."
                : "Numbered senses, with the verses for each. Mid. and pass. mean the verb's middle and passive forms; LXX is the Greek Old Testament; abbreviations like ICC and MM name the scholarly works cited."}
            </p>
            <div className="lex-def">{w.definition}</div>
          </div>
        )}
      </section>

      <div className="lex-credit">
        STEPBible.org · CC BY 4.0 ·{" "}
        <a className="link" href={w.url} target="_blank" rel="noreferrer noopener">Open in STEPBible <ExternalLink className="lucide" style={{ width: 11, height: 11 }} /></a>
      </div>
    </div>
  );
}

/** A word study on its own, from the passage's original words. */
export function WordDrawer({ word, onClose }: { word: { strong: string; at: string; lemma?: string } | null; onClose: () => void }) {
  return (
    <Drawer open={!!word} onClose={onClose} label={word?.lemma ? `Word study: ${word.lemma}` : "Word study"}>
      {word && (
        <>
          <div className="drawer-head">
            <div className="row">
              <div className="grow">
                <div className="drawer-kicker"><span className="label">Word study</span></div>
              </div>
              <button className="icon-btn" onClick={onClose} aria-label="Close" data-autofocus>
                <X className="lucide" />
              </button>
            </div>
          </div>
          <div className="drawer-body">
            <WordStudy strong={word.strong} at={word.at} />
          </div>
        </>
      )}
    </Drawer>
  );
}

/** The passage's own Hebrew or Greek words, each opening its word study. Shown under the passage while you read. */
export function OriginalWords({ studyId, onOpen }: { studyId: string; onOpen: (w: { strong: string; at: string; lemma: string }) => void }) {
  const q = useQuery<{ available: boolean; language: string; words: { ref: string; usfm: string; c: number; v: number; word: string; translit: string; gloss: string; strong: string; lemma: string; meaning: string; count: number }[] }>({
    queryKey: ["passage-words", studyId],
    queryFn: () => api(`/api/studies/${studyId}/words`),
    staleTime: Infinity,
  });
  const [open, setOpen] = useState(true);
  if (!q.data?.available || !q.data.words.length) return null;
  const lang = q.data.language === "he" ? "Hebrew" : "Greek";
  const book = (ref: string) => ref.replace(/\s\d+:\d+$/, "");
  const verses = new Set(q.data.words.map((w) => w.ref)).size;
  return (
    <section className="ow" aria-label={`The ${lang} words`}>
      <button className="ow-toggle" onClick={() => setOpen((x) => !x)} aria-expanded={open}>
        <span className="ow-title">The {lang} words</span>
        <ChevronDown className="lucide" style={{ transform: open ? "rotate(180deg)" : undefined }} />
      </button>
      {open && (
        <div className="ow-words">
          {q.data.words.map((w) => (
            <button key={w.strong} className="ow-word" onClick={() => onOpen({ strong: w.strong, at: w.usfm, lemma: w.lemma })} title={`${w.lemma} (${w.translit}) — ${w.meaning}. Used ${w.count} times.`}>
              <span className="ow-orig" lang={q.data!.language === "he" ? "he" : "grc"}>{w.word}</span>
              <span className="ow-gloss">{w.gloss}</span>
              {verses > 1 && <span className="ow-ref">{w.ref.replace(book(w.ref) + " ", "")}</span>}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
