// jQuery UMD shim.
// bootstrap-table is a UMD bundle
// that resolve jQuery via `globalThis.jQuery` at runtime. Since jQuery is bundled as ESM,
// it is never attached to the global, so it would see `undefined`.
// Importing THIS module before them attaches jQuery to the global first (ESM evaluates
// dependencies in source order), so it finds the same jQuery instance.
import $ from 'jquery';

globalThis.jQuery = $;
globalThis.$ = $;

export default $;
