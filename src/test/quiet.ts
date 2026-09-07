// Injected into every bundled test file by scripts/test.mjs (esbuild `inject`),
// so it applies to the whole suite without each test having to opt in.
//
// Jiffy uses `console.debug` for the reasons behind an expected outcome — a
// direct fetch that CORS refused, a player bundle that wouldn't load, a frame
// export the clipboard blocked. The tests deliberately drive those paths, so a
// passing run prints pages of stack traces and a real failure is lost in them.
// Silence it unless JIFFY_TEST_VERBOSE is set; nothing else is touched, so a
// stray console.log/warn/error still stands out.
if (!process.env["JIFFY_TEST_VERBOSE"]) console.debug = () => {};
