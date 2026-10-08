// The passage, large and serif. In the whole chapter, the studied verses are highlighted the way checked quotations
// are in the brief; every other verse stays fully readable. Each verse carries its number, so a line you highlight
// is cited by the verse it came from.
export function Passage({ passage, showChapter, cite }: { passage: any; showChapter: boolean; cite?: string }) {
  const r = passage.range;
  const inRange = (c: number, v: number) => (c > r.c1 || v >= r.v1) && (c < r.c2 || v <= r.v2);
  return (
    <div className={`passage ${showChapter ? "chapter" : ""}`} data-keep={cite ?? ""} data-book={r.book} data-translation={passage.translation}>
      {passage.chapters.map((ch: any) => {
        const verses = showChapter ? ch.verses : ch.verses.filter((v: any) => inRange(ch.chapter, v.n));
        return (
          <div key={ch.chapter}>
            {passage.chapters.length > 1 && <div className="heading">Chapter {ch.chapter}</div>}
            {verses.map((v: any) => {
              const h = showChapter ? ch.headings.find((x: any) => x.beforeVerse === v.n) : null;
              const focus = showChapter && inRange(ch.chapter, v.n);
              return (
                <span key={v.n}>
                  {h && <span className="heading" style={{ display: "block" }}>{h.text}</span>}
                  <span className={`v ${focus ? "focus" : ""}`} aria-current={focus ? "true" : undefined} data-v={`${ch.chapter}:${v.n}`}>
                    <sup>{v.n}</sup>
                    {v.text}
                  </span>{" "}
                </span>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
