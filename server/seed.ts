// Source directory, domains, and review seeds. The user edits these in the app.
import type { DB } from "./db.ts";
import { nowIso } from "./db.ts";

interface SeedAuthor {
  id: string;
  display_name: string;
  full_identity: string;
  tradition: string;
  hcf: string[];
  sefaria?: string;
  biblehub?: string;
  /** Bible Hub chapter-commentary slug (biblehub.com/commentaries/<slug>/<book>/<chapter>.htm). */
  chapter?: string;
  /** A dedicated gatherer: Enduring Word chapter pages. */
  gatherer?: "enduringword";
  /** Sites searched for this author's written comment on a passage (articles, columns, sermon texts). */
  web?: string[];
  preferred?: number; // rank
  care_note?: string;
}

export const SEED_AUTHORS: SeedAuthor[] = [
  // Preachers, pastors, and popular commentaries. The ranking is a starting point that the user
  // reorders in Settings. Scripture itself outranks every voice.
  { id: "matthew-henry", display_name: "Matthew Henry", full_identity: "Matthew Henry (1662–1714), Presbyterian minister", tradition: "post_reformation", hcf: [], biblehub: "Matthew Henry's Concise Commentary", chapter: "mhc", preferred: 1 },
  { id: "spurgeon", display_name: "Charles Spurgeon", full_identity: "Charles Spurgeon (1834–1892), Baptist preacher", tradition: "evangelical", hcf: [], web: ["spurgeon.org"], preferred: 2 },
  { id: "wesley", display_name: "John Wesley", full_identity: "John Wesley (1703–1791), Anglican priest and founder of Methodism", tradition: "post_reformation", hcf: [], chapter: "wes", web: ["wesley.nnu.edu"], preferred: 3 },
  { id: "guzik", display_name: "David Guzik", full_identity: "David Guzik, Enduring Word Bible Commentary", tradition: "evangelical", hcf: [], gatherer: "enduringword", preferred: 4 },
  { id: "clarke", display_name: "Adam Clarke", full_identity: "Adam Clarke (1762–1832), Methodist minister and commentator", tradition: "post_reformation", hcf: [], chapter: "clarke", preferred: 5 },
  { id: "augustine", display_name: "Augustine of Hippo", full_identity: "Augustine of Hippo (354–430), bishop of Hippo", tradition: "patristic_west", hcf: ["Augustine of Hippo"], preferred: 6 },
  { id: "aquinas", display_name: "Thomas Aquinas", full_identity: "Thomas Aquinas (1225–1274), Dominican friar", tradition: "medieval", hcf: ["Thomas Aquinas"], preferred: 7 },
  { id: "gregory-great", display_name: "Gregory the Great", full_identity: "Gregory the Great (c. 540–604), bishop of Rome", tradition: "patristic_west", hcf: ["Gregory the Dialogist"], preferred: 8 },
  { id: "gregory-nyssa", display_name: "Gregory of Nyssa", full_identity: "Gregory of Nyssa (c. 335–c. 395), bishop, Cappadocian Father", tradition: "patristic_east", hcf: ["Gregory of Nyssa"], preferred: 9 },
  { id: "gregory-nazianzus", display_name: "Gregory of Nazianzus", full_identity: "Gregory of Nazianzus (c. 329–390), bishop, Cappadocian Father", tradition: "patristic_east", hcf: ["Gregory of Nazianzus"], preferred: 10 },
  { id: "luther", display_name: "Martin Luther", full_identity: "Martin Luther (1483–1546), reformer", tradition: "reformation", hcf: ["Martin Luther"], preferred: 11, care_note: "Never quote his 1543 anti-Jewish writings approvingly." },
  { id: "calvin", display_name: "John Calvin", full_identity: "John Calvin (1509–1564), reformer", tradition: "reformation", hcf: ["John Calvin"], preferred: 12 },
  { id: "rashi", display_name: "Rashi", full_identity: "Rashi (Shlomo Yitzchaki, 1040–1105), French rabbi and commentator", tradition: "jewish", hcf: [], sefaria: "Rashi", preferred: 13 },
  { id: "billy-graham", display_name: "Billy Graham", full_identity: "Billy Graham (1918–2018), evangelist", tradition: "evangelical", hcf: [], web: ["billygraham.org", "decisionmagazine.com"] },
  { id: "franklin-graham", display_name: "Franklin Graham", full_identity: "Franklin Graham, evangelist, president of the Billy Graham Evangelistic Association", tradition: "evangelical", hcf: [], web: ["billygraham.org", "decisionmagazine.com"] },
  { id: "chrysostom", display_name: "John Chrysostom", full_identity: "John Chrysostom (c. 347–407), archbishop of Constantinople", tradition: "patristic_east", hcf: ["John Chrysostom"] },
  { id: "origen", display_name: "Origen", full_identity: "Origen of Alexandria (c. 185–c. 253)", tradition: "patristic_east", hcf: ["Origen of Alexandria"], care_note: "Some of his teachings were condemned at a later council." },
  { id: "jerome", display_name: "Jerome", full_identity: "Jerome (c. 347–420), priest and translator", tradition: "patristic_west", hcf: ["Jerome"] },
  { id: "ambrose", display_name: "Ambrose of Milan", full_identity: "Ambrose of Milan (c. 340–397), bishop", tradition: "patristic_west", hcf: ["Ambrose of Milan"] },
  { id: "basil", display_name: "Basil of Caesarea", full_identity: "Basil of Caesarea (330–379), bishop, Cappadocian Father", tradition: "patristic_east", hcf: ["Basil of Caesarea"] },
  { id: "bede", display_name: "Bede", full_identity: "The Venerable Bede (c. 673–735), monk and historian", tradition: "medieval", hcf: ["Bede"] },
  { id: "gill", display_name: "John Gill", full_identity: "John Gill (1697–1771), Baptist pastor", tradition: "post_reformation", hcf: [], biblehub: "Gill's Exposition of the Entire Bible" },
  { id: "keil-delitzsch", display_name: "Keil and Delitzsch", full_identity: "C. F. Keil (1807–1888) and Franz Delitzsch (1813–1890)", tradition: "modern", hcf: [], biblehub: "Keil and Delitzsch Biblical Commentary on the Old Testament" },
  { id: "ellicott", display_name: "Ellicott", full_identity: "Charles Ellicott (1819–1905), ed., Commentary for English Readers", tradition: "modern", hcf: [], biblehub: "Ellicott's Commentary for English Readers" },
  { id: "benson", display_name: "Joseph Benson", full_identity: "Joseph Benson (1749–1821), Methodist minister", tradition: "post_reformation", hcf: [], biblehub: "Benson Commentary" },
  { id: "barnes", display_name: "Albert Barnes", full_identity: "Albert Barnes (1798–1870), Presbyterian minister", tradition: "modern", hcf: [], biblehub: "Barnes' Notes on the Bible" },
  { id: "jfb", display_name: "Jamieson, Fausset, and Brown", full_identity: "Robert Jamieson, A. R. Fausset, and David Brown (1871)", tradition: "modern", hcf: [], biblehub: "Jamieson-Fausset-Brown Bible Commentary" },
  { id: "poole", display_name: "Matthew Poole", full_identity: "Matthew Poole (1624–1679), Puritan", tradition: "post_reformation", hcf: [], biblehub: "Matthew Poole's Commentary" },
  { id: "maclaren", display_name: "Alexander MacLaren", full_identity: "Alexander MacLaren (1826–1910), Baptist preacher", tradition: "modern", hcf: [], biblehub: "MacLaren's Expositions" },
  { id: "geneva", display_name: "Geneva Study Bible", full_identity: "Geneva Bible notes (1599)", tradition: "reformation", hcf: [], biblehub: "Geneva Study Bible" },
  { id: "cambridge", display_name: "Cambridge Bible", full_identity: "Cambridge Bible for Schools and Colleges (1878–1918)", tradition: "modern", hcf: [], biblehub: "Cambridge Bible for Schools and Colleges" },
  { id: "pulpit", display_name: "Pulpit Commentary", full_identity: "The Pulpit Commentary (1880–1919)", tradition: "modern", hcf: [], biblehub: "Pulpit Commentary" },
  { id: "ibn-ezra", display_name: "Abraham ibn Ezra", full_identity: "Abraham ibn Ezra (1089–c. 1167), rabbi and commentator", tradition: "jewish", hcf: [], sefaria: "Ibn Ezra" },
  { id: "ramban", display_name: "Nachmanides (Ramban)", full_identity: "Nachmanides (Ramban, 1194–1270), rabbi and commentator", tradition: "jewish", hcf: [], sefaria: "Ramban" },
  { id: "sforno", display_name: "Sforno", full_identity: "Obadiah Sforno (c. 1475–1550), Italian rabbi", tradition: "jewish", hcf: [], sefaria: "Sforno" },
];

/** Bump when SEED_AUTHORS gains voices or source mappings that existing libraries should receive. */
const VOICES_VERSION = 2;
/** Voices added in version 2, placed ahead of the user's earlier preferred list. */
const VOICES_V2_TOP = ["matthew-henry", "spurgeon", "wesley", "guzik", "clarke"];

export const SEED_DOMAINS: [string, "primary" | "context" | "blocked", string?][] = [
  ...["ccel.org", "www.ccel.org", "newadvent.org", "www.newadvent.org", "sefaria.org", "www.sefaria.org", "biblehub.com", "bookofconcord.org", "www.bookofconcord.org", "clerus.org", "www.clerus.org", "archive.org", "corpusthomisticum.org", "documentacatholicaomnia.eu", "tertullian.org", "spurgeon.org", "www.spurgeon.org", "enduringword.com", "billygraham.org", "decisionmagazine.com", "wesley.nnu.edu"].map((h) => [h, "primary"] as [string, "primary"]),
  ["wikipedia.org", "context", "Can point to sources; never sufficient evidence for an attribution."],
  ...["goodreads.com", "azquotes.com", "brainyquote.com", "quotefancy.com", "quotes.net", "wisdomquotes.com", "pinterest.com", "facebook.com", "instagram.com", "tiktok.com", "x.com", "twitter.com", "reddit.com", "quora.com"].map((h) => [h, "blocked"] as [string, "blocked"]),
  ["studylight.org", "blocked", "Refuses automated requests (403)."],
];

export const BANNED_PHRASES = [
  "here's the thing", "let that sink in", "delve", "tapestry", "in a world where", "game-changer", "unpack", "navigate the complexities",
  "a powerful reminder", "resonates deeply", "testament to", "at the end of the day", "buckle up", "let's dive in", "🧵", "thread 👇",
];

export const WATCHLIST: { quote: string; author: string; status: "spurious" | "unsourced" | "disputed" | "context-sensitive"; note: string }[] = [
  { quote: "Preach the gospel at all times; when necessary, use words", author: "Francis of Assisi", status: "spurious", note: "Not found in his writings." },
  { quote: "In essentials unity, in non-essentials liberty, in all things charity", author: "Augustine", status: "spurious", note: "17th-century; usually traced to Rupertus Meldenius." },
  { quote: "Even if I knew tomorrow the world would end, I would still plant my apple tree", author: "Luther", status: "spurious", note: "First attested in the 20th century." },
  { quote: "The church is a hospital for sinners, not a museum for saints", author: "Augustine", status: "unsourced", note: "Not found in his works." },
  { quote: "He who sings prays twice", author: "Augustine", status: "unsourced", note: "No exact source; paraphrases circulate." },
  { quote: "Hope has two beautiful daughters: anger and courage", author: "Augustine", status: "unsourced", note: "No source located." },
  { quote: "Here I stand; I can do no other", author: "Luther", status: "disputed", note: "Absent from the earliest transcripts of his words at Worms." },
  { quote: "Love, and do what you will", author: "Augustine", status: "context-sensitive", note: "Genuine (Homilies on 1 John 7.8); often used out of context." },
];

export function seed(db: DB) {
  const now = nowIso();
  const hasAuthors = (db.prepare("SELECT COUNT(*) n FROM authors").get() as any).n > 0;
  const ins = db.prepare(`INSERT OR IGNORE INTO authors (id, display_name, full_identity, tradition, hcf_names_json, sefaria_collective_title, biblehub_section_title,
    is_preferred, preference_rank, care_note, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const version = Number((db.prepare("SELECT value_json FROM preferences WHERE key = 'seedVoicesVersion'").get() as any)?.value_json ?? (hasAuthors ? 1 : 0));
  db.transaction(() => {
    if (!hasAuthors) {
      for (const a of SEED_AUTHORS) ins.run(a.id, a.display_name, a.full_identity, a.tradition, JSON.stringify(a.hcf), a.sefaria ?? null, a.biblehub ?? null, a.preferred ? 1 : 0, a.preferred ?? null, a.care_note ?? null, now, now);
    } else if (version < 2) {
      // Keep the user's own order for the voices already preferred; the new voices go first.
      const top = new Set(VOICES_V2_TOP);
      const kept = (db.prepare("SELECT id FROM authors WHERE is_preferred = 1 ORDER BY preference_rank").all() as { id: string }[]).filter((r) => !top.has(r.id));
      for (const a of SEED_AUTHORS) ins.run(a.id, a.display_name, a.full_identity, a.tradition, JSON.stringify(a.hcf), a.sefaria ?? null, a.biblehub ?? null, 0, null, a.care_note ?? null, now, now);
      const rank = db.prepare("UPDATE authors SET is_preferred = 1, preference_rank = ?, updated_at = ? WHERE id = ?");
      [...VOICES_V2_TOP, ...kept.map((r) => r.id)].forEach((id, i) => rank.run(i + 1, now, id));
      db.prepare("UPDATE authors SET tradition = 'evangelical' WHERE id = 'spurgeon'").run();
    }
    // Where each voice is found is the app's knowledge, not a preference: keep it current on every start.
    const map = db.prepare("UPDATE authors SET biblehub_chapter_slug = ?, gatherer = ?, web_domains_json = ? WHERE id = ?");
    for (const a of SEED_AUTHORS) map.run(a.chapter ?? null, a.gatherer ?? null, JSON.stringify(a.web ?? []), a.id);
    if (version < VOICES_VERSION) {
      db.prepare("INSERT INTO preferences (key, value_json, updated_at) VALUES ('seedVoicesVersion', ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json").run(String(VOICES_VERSION), now);
      const host = db.prepare("INSERT OR IGNORE INTO domains (host, policy, notes) VALUES (?,?,?)");
      for (const [h, p, n] of SEED_DOMAINS) host.run(h, p, n ?? null);
    }
  })();
  const hasDomains = (db.prepare("SELECT COUNT(*) n FROM domains").get() as any).n > 0;
  if (!hasDomains) {
    const insD = db.prepare("INSERT INTO domains (host, policy, notes) VALUES (?,?,?)");
    db.transaction(() => SEED_DOMAINS.forEach(([h, p, n]) => insD.run(h, p, n ?? null)))();
  }
}
