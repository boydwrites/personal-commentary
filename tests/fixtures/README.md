# Where the test data comes from

The HTML fixtures here are hand-written examples shaped like the pages each parser reads. The filenames name the parser and passage they exercise, but the prose is invented, not quoted from the named website or commentator. No real pages, scripts, trackers, or user data are included.

`fake-model.ts` and `research-corpus.ts` hold invented model responses and research records. Keys such as `test-key` and `fake-model-key` are placeholders that work nowhere. The empty devotional JSON and verse-of-the-day HTML are small fixed responses.

`stepbible-sample.txt` is a short extract of STEPBible data, with its attribution and CC BY 4.0 notice kept in the file. The full datasets aren't bundled.

Dates, names, notes, and handles in the fixtures are made up for the tests.

## Demo dataset

`demo-bible.json` holds only Exodus 32–33, Acts 7, and John 1 from the public-domain Berean Standard Bible, taken from the [Free Bible API](https://bible.helloao.org/api/BSB/complete.json). More about the translation is at [berean.bible](https://berean.bible/). It is not a full Bible.

The demo also writes two invented cross-reference rows in OpenBible's file format; their rankings are made up, not real community votes. The demo's commentary is invented too. It exists to exercise the parsers and the quotation checker, and none of it should be read as something the real commentators wrote.
